package com.yudatoux.inkstone

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import com.facebook.react.bridge.*
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.Executors

/** Platform details, read receipts and user-selected photos stay at the Android boundary. */
class MobileDeviceModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  private var picking: Promise? = null
  private var selectionLimit = 4
  private val requestCode = 37931
  private val preferences get() = context.getSharedPreferences("inkstone.mobile.read", 0)
  private val listener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, code: Int, result: Int, data: Intent?) {
      if (code != requestCode) return
      val promise = picking ?: return
      picking = null
      if (result != Activity.RESULT_OK || data == null) { promise.resolve(null); return }
      val uris = mutableListOf<Uri>()
      data.clipData?.let { clips -> for (i in 0 until clips.itemCount) uris.add(clips.getItemAt(i).uri) }
      if (uris.isEmpty()) data.data?.let { uris.add(it) }
      executor.execute {
        try {
          val photos = Arguments.createArray()
          uris.distinct().take(selectionLimit).forEach { uri -> photos.pushMap(readPhoto(uri)) }
          promise.resolve(photos)
        } catch (error: Exception) { promise.reject("photo_failed", "无法读取图片，请换一张重试", error) }
      }
    }
  }

  init { context.addActivityEventListener(listener) }
  override fun getName() = "InkstoneMobileDevice"

  @ReactMethod fun info(promise: Promise) {
    val fallback = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
    val name = try { Settings.Global.getString(context.contentResolver, "device_name")?.trim()?.takeIf { it.isNotEmpty() } ?: fallback } catch (_: Exception) { fallback }
    promise.resolve(Arguments.createMap().apply { putString("name", name.take(60)); putString("model", Build.MODEL) })
  }

  @ReactMethod fun readMarks(scope: String, promise: Promise) { promise.resolve(preferences.getString(scope.take(500), "{}")) }
  @ReactMethod fun writeMarks(scope: String, json: String, promise: Promise) {
    if (json.length > 100_000) { promise.reject("marks_large", "已读记录过大"); return }
    preferences.edit().putString(scope.take(500), json).apply()
    promise.resolve(true)
  }

  @ReactMethod fun pickImages(limit: Double, promise: Promise) {
    val activity = context.currentActivity
    if (activity == null || picking != null) { promise.reject("picker_busy", "请稍后重试"); return }
    selectionLimit = limit.toInt().coerceIn(1, 4)
    picking = promise
    activity.runOnUiThread {
      try {
        val intent = if (Build.VERSION.SDK_INT >= 33) Intent(MediaStore.ACTION_PICK_IMAGES).apply {
          type = "image/*"
          if (selectionLimit > 1) putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, selectionLimit.coerceAtMost(MediaStore.getPickImagesMaxLimit()))
        } else Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
          type = "image/*"
          addCategory(Intent.CATEGORY_OPENABLE)
          putExtra(Intent.EXTRA_ALLOW_MULTIPLE, selectionLimit > 1)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.startActivityForResult(intent, requestCode)
      } catch (error: Exception) { picking = null; promise.reject("picker_failed", "无法打开系统图片选择器", error) }
    }
  }

  private fun readPhoto(uri: Uri): WritableMap {
    val resolver = context.contentResolver
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
    require(bounds.outWidth > 0 && bounds.outHeight > 0)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2400) sample *= 2
    var bitmap = resolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) } ?: error("invalid image")
    val orientation = try { resolver.openInputStream(uri).use { ExifInterface(it!!).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } } catch (_: Exception) { ExifInterface.ORIENTATION_NORMAL }
    val matrix = Matrix()
    when (orientation) {
      2 -> matrix.setScale(-1f, 1f)
      3 -> matrix.setRotate(180f)
      4 -> matrix.setScale(1f, -1f)
      5 -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
      6 -> matrix.setRotate(90f)
      7 -> { matrix.setRotate(270f); matrix.postScale(-1f, 1f) }
      8 -> matrix.setRotate(270f)
    }
    if (!matrix.isIdentity) {
      val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
      if (rotated !== bitmap) bitmap.recycle()
      bitmap = rotated
    }
    val scale = minOf(1f, 1600f / maxOf(bitmap.width, bitmap.height))
    if (scale < 1f) {
      val resized = Bitmap.createScaledBitmap(bitmap, maxOf(1, (bitmap.width * scale).toInt()), maxOf(1, (bitmap.height * scale).toInt()), true)
      if (resized !== bitmap) bitmap.recycle()
      bitmap = resized
    }
    try {
      val bytes = ByteArrayOutputStream().apply { bitmap.compress(Bitmap.CompressFormat.JPEG, 82, this) }.toByteArray()
      require(bytes.size <= 2 * 1024 * 1024)
      return Arguments.createMap().apply {
        putString("id", UUID.randomUUID().toString())
        putString("mimeType", "image/jpeg")
        putString("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
        putInt("width", bitmap.width); putInt("height", bitmap.height)
      }
    } finally { bitmap.recycle() }
  }

  override fun invalidate() {
    context.removeActivityEventListener(listener)
    picking?.resolve(null); picking = null
    executor.shutdown()
    super.invalidate()
  }
}
