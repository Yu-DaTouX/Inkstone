package com.yudatoux.inkstone

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/** Returns a locally decoded pairing QR or a cancelled result to the form. */
class PairScannerModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private var pending: Promise? = null
  private val requestCode = 48216

  init {
    context.addActivityEventListener(object : BaseActivityEventListener() {
      override fun onActivityResult(activity: Activity, code: Int, result: Int, data: Intent?) {
        if (code != requestCode) return
        val promise = pending ?: return
        pending = null
        if (result == Activity.RESULT_OK) promise.resolve(data?.getStringExtra("value"))
        else if (result == Activity.RESULT_FIRST_USER) promise.reject("scanner_permission", "需要相机权限才能扫码")
        else promise.resolve(null)
      }
    })
  }

  override fun getName(): String = "InkstonePairScanner"

  @ReactMethod
  fun scan(promise: Promise) {
    Handler(Looper.getMainLooper()).post {
      val activity = reactApplicationContext.currentActivity
      if (activity == null) return@post promise.reject("scanner_unavailable", "应用未处于前台")
      /* 上一次的结果没回来（Activity 被系统回收、进程重建）：当作取消，别让之后每次都报 busy */
      pending?.resolve(null)
      pending = null
      pending = promise
      try {
        activity.startActivityForResult(Intent(activity, PairScannerActivity::class.java), requestCode)
      } catch (error: Exception) {
        pending = null
        promise.reject("scanner_failed", error)
      }
    }
  }

  @ReactMethod
  fun readClipboard(promise: Promise) {
    Handler(Looper.getMainLooper()).post {
      val manager = reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val text = manager.primaryClip?.getItemAt(0)?.coerceToText(reactApplicationContext)?.toString()
      promise.resolve(text)
    }
  }
}
