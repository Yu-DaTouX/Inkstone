package com.yudatoux.inkstone

import android.content.Intent
import android.app.NotificationManager
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Arguments

class QuestionAlertModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "InkstoneQuestionAlerts"

  @ReactMethod
  fun openSettings(promise: Promise) {
    context.startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
      putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    })
    promise.resolve(true)
  }

  @ReactMethod
  fun status(promise: Promise) {
    val enabled = context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
    val wanted = context.getSharedPreferences("inkstone.question.alerts", 0).getBoolean("wanted", false)
    promise.resolve(Arguments.createMap().apply {
      putBoolean("enabled", enabled)
      putBoolean("wanted", wanted)
      putBoolean("active", QuestionAlertService.active)
    })
  }

  @ReactMethod
  fun start(baseUrl: String, token: String, promise: Promise) {
    try {
      val intent = Intent(context, QuestionAlertService::class.java).apply {
        putExtra(QuestionAlertService.EXTRA_BASE_URL, baseUrl)
        putExtra(QuestionAlertService.EXTRA_TOKEN, token)
      }
      ContextCompat.startForegroundService(context, intent)
      context.getSharedPreferences("inkstone.question.alerts", 0).edit().putBoolean("wanted", true).apply()
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("alerts_start_failed", error.message ?: "无法开启后台提醒", error)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    context.getSharedPreferences("inkstone.question.alerts", 0).edit().putBoolean("wanted", false).apply()
    context.stopService(Intent(context, QuestionAlertService::class.java))
    promise.resolve(true)
  }
}
