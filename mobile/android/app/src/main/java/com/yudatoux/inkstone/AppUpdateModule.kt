package com.yudatoux.inkstone

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

class AppUpdateModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  private val allowedHosts = setOf("github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com")

  override fun getName() = "InkstoneAppUpdate"

  override fun getConstants(): Map<String, Any> = mapOf("version" to (packageInfo(context.packageName, 0)?.versionName ?: "0.0.0"))

  @Suppress("DEPRECATION")
  private fun packageInfo(name: String, flags: Int): PackageInfo? = try {
    if (Build.VERSION.SDK_INT >= 33) context.packageManager.getPackageInfo(name, PackageManager.PackageInfoFlags.of(flags.toLong()))
    else context.packageManager.getPackageInfo(name, flags)
  } catch (_: Exception) { null }

  @Suppress("DEPRECATION")
  private fun signatures(info: PackageInfo?): Set<String> {
    val raw = if (Build.VERSION.SDK_INT >= 28) info?.signingInfo?.let { if (it.hasMultipleSigners()) it.apkContentsSigners else it.signingCertificateHistory } else info?.signatures
    return raw?.map { MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).joinToString("") { b -> "%02x".format(b) } }?.toSet() ?: emptySet()
  }

  private fun progress(received: Long, total: Long) {
    context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("InkstoneUpdateProgress", Arguments.createMap().apply { putDouble("received", received.toDouble()); putDouble("total", total.toDouble()) })
  }

  private fun open(url: String, hops: Int = 0): HttpURLConnection {
    val target = URL(url)
    if (target.protocol != "https" || target.host !in allowedHosts) throw IllegalArgumentException("下载地址不受信任：${target.host}")
    val connection = (target.openConnection() as HttpURLConnection).apply {
      instanceFollowRedirects = false
      connectTimeout = 15_000
      readTimeout = 30_000
      setRequestProperty("Accept", "application/octet-stream")
    }
    val code = connection.responseCode
    if (code in 300..399) {
      val next = connection.getHeaderField("Location") ?: throw IllegalStateException("下载跳转缺少地址")
      connection.disconnect()
      if (hops >= 5) throw IllegalStateException("下载跳转次数过多")
      return open(URL(target, next).toString(), hops + 1)
    }
    if (code != 200) throw IllegalStateException("下载失败（HTTP $code）")
    return connection
  }

  @ReactMethod
  fun download(url: String, expectedVersion: String, promise: Promise) {
    executor.execute {
      val dir = File(context.cacheDir, "updates").apply { mkdirs() }
      val partial = File(dir, "inkstone-update.apk.part")
      val apk = File(dir, "inkstone-update.apk")
      try {
        val connection = open(url)
        val total = connection.contentLengthLong
        var received = 0L
        var reported = 0L
        connection.inputStream.use { input ->
          partial.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              val n = input.read(buffer)
              if (n < 0) break
              output.write(buffer, 0, n)
              received += n
              if (received - reported >= 256 * 1024) { reported = received; progress(received, total) }
            }
          }
        }
        connection.disconnect()
        progress(received, total)
        apk.delete()
        if (!partial.renameTo(apk)) throw IllegalStateException("无法保存安装包")
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
        @Suppress("DEPRECATION")
        val archive = context.packageManager.getPackageArchiveInfo(apk.path, flags)?.apply {
          applicationInfo?.sourceDir = apk.path
          applicationInfo?.publicSourceDir = apk.path
        } ?: throw IllegalStateException("下载的文件不是有效的安装包")
        if (archive.packageName != context.packageName) throw IllegalStateException("安装包不属于砚手机端")
        if (archive.versionName != expectedVersion) throw IllegalStateException("安装包版本不对：${archive.versionName}")
        val installed = signatures(packageInfo(context.packageName, flags))
        if (installed.isEmpty() || signatures(archive).intersect(installed).isEmpty()) throw IllegalStateException("安装包签名与当前应用不一致，已拒绝安装")
        promise.resolve(apk.path)
      } catch (error: Exception) {
        partial.delete()
        apk.delete()
        promise.reject("update_download_failed", error.message ?: "下载失败", error)
      }
    }
  }

  @ReactMethod
  fun install(path: String, promise: Promise) {
    try {
      val apk = File(path)
      val dir = File(context.cacheDir, "updates")
      if (!apk.exists() || apk.parentFile?.canonicalPath != dir.canonicalPath) throw IllegalArgumentException("安装包不存在")
      if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        promise.resolve("permission")
        return
      }
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", apk)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      promise.resolve("started")
    } catch (error: Exception) {
      promise.reject("update_install_failed", error.message ?: "无法打开安装界面", error)
    }
  }

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}
}
