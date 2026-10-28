package com.yudatoux.inkstone

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale

/** Recognizes through the installed service while the composer owns the recording UI. */
class SpeechInputModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val main = Handler(Looper.getMainLooper())
  private var pending: Promise? = null
  private var recognizer: SpeechRecognizer? = null
  private var timeout: Runnable? = null
  private var phase = "idle"
  private var lastLevelAt = 0L
  private var serviceNeedingPermission: String? = null

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
  fun record(promise: Promise) {
    main.post {
      if (pending != null) return@post promise.reject("speech_busy", "已有语音输入正在进行")
      if (ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        return@post promise.reject("speech_permission_required", "需要麦克风权限才能使用语音输入")
      }
      pending = promise
      startRecording()
    }
  }

  @ReactMethod
  fun stop() {
    main.post {
      if (pending != null && phase != "processing") {
        emit("processing")
        recording = false
        recognizer?.stopListening()
      }
    }
  }

  @Volatile private var recording = false
  private var recorder: Thread? = null

  private fun startRecording() {
    val rate = 16_000
    val minSize = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val audio = try {
      AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minSize, rate))
    } catch (error: Exception) { return reject("speech_unavailable", error.message ?: "无法打开麦克风") }
    if (audio.state != AudioRecord.STATE_INITIALIZED) { audio.release(); return reject("speech_unavailable", "无法打开麦克风") }
    recording = true
    emit("listening")
    recorder = Thread {
      val pcm = ByteArrayOutputStream()
      val buffer = ShortArray(rate / 10)
      val limit = rate * 2 * 120
      var loudest = 0
      try {
        audio.startRecording()
        while (recording && pcm.size() < limit) {
          val read = audio.read(buffer, 0, buffer.size)
          if (read <= 0) continue
          var peak = 0
          for (i in 0 until read) {
            val sample = buffer[i].toInt()
            peak = maxOf(peak, kotlin.math.abs(sample))
            pcm.write(sample and 0xff)
            pcm.write((sample shr 8) and 0xff)
          }
          loudest = maxOf(loudest, peak)
          val level = (peak / 12000f).coerceIn(0f, 1f)
          main.post { if (phase == "listening") emit("listening", level) }
        }
      } catch (_: Exception) {
      } finally {
        try { audio.stop() } catch (_: Exception) {}
        audio.release()
      }
      val wav = wavOf(pcm.toByteArray(), rate)
      main.post {
        if (pending == null) return@post
        if (pcm.size() < rate / 2) reject("speech_empty", "录音太短，请再试一次")
        else if (loudest < 1500) reject("speech_empty", "没有听到声音，请靠近麦克风再试一次")
        else resolve(Base64.encodeToString(wav, Base64.NO_WRAP))
      }
    }.also { it.start() }
  }

  private fun wavOf(pcm: ByteArray, rate: Int): ByteArray {
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray()); putInt(36 + pcm.size); put("WAVE".toByteArray())
      put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1); putInt(rate); putInt(rate * 2); putShort(2); putShort(16)
      put("data".toByteArray()); putInt(pcm.size)
    }
    return header.array() + pcm
  }

  @ReactMethod fun cancel() { main.post { resolve(null) } }

  /** 打开缺麦克风权限的识别服务应用的系统详情页 */
  @ReactMethod
  fun openServiceSettings(promise: Promise) {
    val pkg = serviceNeedingPermission ?: return promise.resolve(false)
    try {
      val intent = Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.fromParts("package", pkg, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactApplicationContext.startActivity(intent)
      promise.resolve(true)
    } catch (_: Exception) { promise.resolve(false) }
  }

  private fun emit(state: String, level: Float = 0f) {
    phase = state
    val event = Arguments.createMap().apply {
      putString("state", state)
      putDouble("level", level.toDouble())
    }
    reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("inkstone-speech-state", event)
  }

  /** Google 的识别服务按这个顺序优先：Google 应用、设备端智能服务、Google 语音服务；不是 Google 的排在后面 */
  private val googleServices = listOf("com.google.android.googlequicksearchbox", "com.google.android.as", "com.google.android.tts")
  private fun googleRank(pkg: String): Int = googleServices.indexOf(pkg).let { if (it < 0) googleServices.size else it }

  /**
   * 选识别服务：只考虑自己有麦克风权限的（没权限的会直接报「权限不足」）。
   * 顺序：Google → 系统设置里的默认识别服务 → 其他任意一个。全都没权限时返回 null。
   */
  private fun pickRecognitionService(services: List<android.content.pm.ServiceInfo>): android.content.pm.ServiceInfo? {
    val pm = reactApplicationContext.packageManager
    val usable = services.filter { pm.checkPermission(Manifest.permission.RECORD_AUDIO, it.packageName) == PackageManager.PERMISSION_GRANTED }
    usable.filter { googleRank(it.packageName) < googleServices.size }.minByOrNull { googleRank(it.packageName) }?.let { return it }
    val preferred = try {
      android.provider.Settings.Secure.getString(reactApplicationContext.contentResolver, "voice_recognition_service")
        ?.let(ComponentName::unflattenFromString)
    } catch (_: Exception) { null }
    usable.firstOrNull { preferred != null && it.packageName == preferred.packageName && it.name == preferred.className }?.let { return it }
    return usable.firstOrNull()
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
      if (services.isEmpty()) return reject("speech_unavailable", "系统无识别服务，可用键盘语音输入")
      val pick = pickRecognitionService(services.map { it.serviceInfo })
      if (pick == null) {
        /* 砚自己已有权限；缺权限的是负责转写的应用。报错点名（有 Google 就点名 Google），并记下包名供「去授权」跳转 */
        val info = services.map { it.serviceInfo }.sortedBy { googleRank(it.packageName) }.first()
        val label = try { info.applicationInfo.loadLabel(context.packageManager).toString() } catch (_: Exception) { info.packageName }
        serviceNeedingPermission = info.packageName
        return reject("speech_service_permission", "砚已有麦克风权限，但负责转写的「$label」没有。请给「$label」授权麦克风，或改用键盘语音输入")
      }
      val speech = SpeechRecognizer.createSpeechRecognizer(context, ComponentName(pick.packageName, pick.name))
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
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "砚已有麦克风权限，但手机的语音识别服务没有；请在系统设置里给识别服务应用授权"
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
    recording = false
    recorder = null
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
