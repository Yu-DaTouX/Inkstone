package com.yudatoux.inkstone

import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlinx.coroutines.*

/** Native window coordinates are converted to dp; JS subtracts its safe-content origin. */
class FoldLayoutModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var job: Job? = null
  private var listeners = 0
  private var feature: FoldingFeature? = null
  init { context.addLifecycleEventListener(this) }
  override fun getName() = "InkstoneFoldLayout"
  private fun snapshot(): WritableMap = Arguments.createMap().apply {
    val fold = feature
    putBoolean("separating", fold?.isSeparating == true || fold?.occlusionType == FoldingFeature.OcclusionType.FULL)
    if (fold != null) {
      val density = context.resources.displayMetrics.density
      putString("orientation", if (fold.orientation == FoldingFeature.Orientation.VERTICAL) "vertical" else "horizontal")
      putString("posture", if (fold.state == FoldingFeature.State.HALF_OPENED) "half-open" else "flat")
      putDouble("left", fold.bounds.left / density.toDouble())
      putDouble("right", fold.bounds.right / density.toDouble())
      putDouble("top", fold.bounds.top / density.toDouble())
      putDouble("bottom", fold.bounds.bottom / density.toDouble())
    }
  }
  private fun watch() {
    job?.cancel()
    val activity = context.currentActivity ?: return
    if (listeners <= 0) return
    job = scope.launch {
      try {
        WindowInfoTracker.getOrCreate(context).windowLayoutInfo(activity).collect { layout ->
          feature = layout.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull()
          // Geometry only: useful for device layout diagnostics without logging session content.
          android.util.Log.i("InkstoneFoldLayout", "fold=${feature?.orientation}, posture=${feature?.state}, separating=${feature?.isSeparating}, bounds=${feature?.bounds}")
          context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("inkstone-fold-layout", snapshot())
        }
      } catch (_: CancellationException) { /* Activity paused or bridge disposed. */ }
      catch (_: Exception) {
        feature = null
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("inkstone-fold-layout", snapshot())
      }
    }
  }
  @ReactMethod fun getCurrent(promise: Promise) { promise.resolve(snapshot()) }
  @ReactMethod fun addListener(name: String) { listeners++; context.runOnUiQueueThread { watch() } }
  @ReactMethod fun removeListeners(count: Double) {
    listeners = (listeners - count.toInt()).coerceAtLeast(0)
    if (listeners == 0) context.runOnUiQueueThread { job?.cancel(); job = null }
  }
  override fun onHostResume() { watch() }
  override fun onHostPause() { job?.cancel(); job = null }
  override fun onHostDestroy() { job?.cancel(); job = null }
  override fun invalidate() { context.removeLifecycleEventListener(this); scope.cancel(); super.invalidate() }
}
