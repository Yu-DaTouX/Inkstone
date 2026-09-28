package com.yudatoux.inkstone

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale

/** Recognizes through the installed service while the composer owns the recording UI. */
class SpeechInputModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val main = Handler(Looper.getMainLooper())
  private var pending: Promise? = null
  private var recognizer: SpeechRecognizer? = null
  private var timeout: Runnable? = null
  private var phase = "idle"
  private var lastLevelAt = 0L

  init { context.addLifecycleEventListener(this) }
  override fun getName(): String = "InkstoneSpeechInput"
  @ReactMethod fun addListener(eventName: String) = Unit
  @ReactMethod fun removeListeners(count: Int) = Unit

  @ReactMethod
  fun recognize(promise: Promise) {
    main.post {
      if (pending != null) return@post promise.reject("speech_busy", "已有语音输入正在进行")
      if (reactApplicationContext.currentActivity == null) return@post promise.reject("speech_unavailable", "应用未处于前台")
      pending = promise
      startRecognition()
    }
  }

  @ReactMethod
  fun stop() {
    main.post {
      if (pending != null && phase != "processing") {
        emit("processing")
        recognizer?.stopListening()
      }
    }
  }

  @ReactMethod fun cancel() { main.post { resolve(null) } }

  private fun emit(state: String, level: Float = 0f) {
    phase = state
    val event = Arguments.createMap().apply {
      putString("state", state)
      putDouble("level", level.toDouble())
    }
    reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("inkstone-speech-state", event)
  }

  private fun startRecognition() {
    val context = reactApplicationContext
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      return reject("speech_permission_required", "需要麦克风权限才能使用语音输入")
    }
    if (!SpeechRecognizer.isRecognitionAvailable(context)) {
      return reject("speech_unavailable", "系统无识别服务，可用键盘语音输入")
    }
    try {
      val services = if (Build.VERSION.SDK_INT >= 33) {
        context.packageManager.queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), PackageManager.ResolveInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        context.packageManager.queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), 0)
      }
      if (services.size == 1 && context.packageManager.checkPermission(Manifest.permission.RECORD_AUDIO, services.first().serviceInfo.packageName) != PackageManager.PERMISSION_GRANTED) {
        return reject("speech_service_permission", "识别服务缺少麦克风权限，请在系统设置授权")
      }
      val speech = if (services.size == 1) {
        val info = services.first().serviceInfo
        SpeechRecognizer.createSpeechRecognizer(context, ComponentName(info.packageName, info.name))
      } else SpeechRecognizer.createSpeechRecognizer(context)
      recognizer = speech
      speech.setRecognitionListener(object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) { if (recognizer === speech) emit("listening") }
        override fun onBeginningOfSpeech() { if (recognizer === speech) emit("listening") }
        override fun onRmsChanged(rmsdB: Float) {
          if (recognizer !== speech || phase != "listening") return
          val now = SystemClock.elapsedRealtime()
          if (now - lastLevelAt < 80) return
          lastLevelAt = now
          emit("listening", (rmsdB / 10f).coerceIn(0f, 1f))
        }
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() { if (recognizer === speech) emit("processing") }
        override fun onPartialResults(partialResults: Bundle?) = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
        override fun onResults(results: Bundle?) {
          if (recognizer !== speech) return
          val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()
          if (text.isNullOrEmpty()) reject("speech_empty", "没有听清，请再试一次") else resolve(text)
        }
        override fun onError(error: Int) {
          if (recognizer !== speech) return
          val message = when (error) {
            SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "没有听清，请再试一次"
            SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "语音识别服务无法连接网络"
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "语音识别服务没有麦克风权限"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "手机的识别服务正在使用中，请稍后重试"
            SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "识别服务暂不支持当前语言，请检查系统语音设置"
            else -> "语音识别失败（错误 $error）"
          }
          reject("speech_failed", message)
        }
      })
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
      }
      emit("starting")
      timeout = Runnable { reject("speech_timeout", "语音识别等待超时，请重试") }.also { main.postDelayed(it, 45_000) }
      speech.startListening(intent)
    } catch (error: Exception) {
      reject("speech_unavailable", error.message ?: "无法启动系统语音识别服务")
    }
  }

  private fun resolve(text: String?) {
    val promise = pending ?: return
    cleanup()
    promise.resolve(text)
  }

  private fun reject(code: String, message: String) {
    val promise = pending ?: return
    cleanup()
    promise.reject(code, message)
  }

  private fun cleanup() {
    timeout?.let(main::removeCallbacks)
    timeout = null
    val speech = recognizer
    recognizer = null
    speech?.cancel()
    speech?.destroy()
    pending = null
    lastLevelAt = 0L
    emit("idle")
  }

  override fun onHostResume() = Unit
  override fun onHostPause() { main.post { resolve(null) } }
  override fun onHostDestroy() { main.post { resolve(null) } }
  override fun invalidate() {
    reactApplicationContext.removeLifecycleEventListener(this)
    main.post { resolve(null) }
    super.invalidate()
  }
}
