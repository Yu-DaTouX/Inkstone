package com.yudatoux.inkstone

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

/** CameraX preview and bundled ML Kit decoder, usable without Google Play services. */
class PairScannerActivity : ComponentActivity() {
  private val executor = Executors.newSingleThreadExecutor()
  private val decoder = BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
  private lateinit var previewView: PreviewView
  @Volatile private var completed = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(21, 21, 21)) }
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      view.setPadding(0, bars.top, 0, bars.bottom)
      insets
    }
    previewView = PreviewView(this)
    root.addView(previewView, FrameLayout.LayoutParams(-1, -1))
    val title = TextView(this).apply {
      text = "扫描电脑上的配对二维码"
      textSize = 18f
      setTextColor(Color.WHITE)
      setBackgroundColor(Color.rgb(21, 21, 21))
      setPadding(24, 22, 24, 22)
      gravity = Gravity.CENTER
    }
    root.addView(title, FrameLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
    val close = TextView(this).apply {
      text = "关闭"
      textSize = 16f
      setTextColor(Color.WHITE)
      setBackgroundColor(Color.rgb(43, 43, 41))
      setPadding(24, 16, 24, 16)
      setOnClickListener { finish() }
    }
    root.addView(close, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = 48 })
    setContentView(root)
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera()
    else requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != 1) return
    if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startCamera()
    else { setResult(Activity.RESULT_FIRST_USER); finish() }
  }

  private var cameraProvider: ProcessCameraProvider? = null

  private fun startCamera() {
    val future = ProcessCameraProvider.getInstance(this)
    future.addListener({
      try {
        val provider = future.get()
        cameraProvider = provider
        val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        analysis.setAnalyzer(executor) { frame ->
          val image = frame.image
          if (image == null || completed) { frame.close(); return@setAnalyzer }
          val task = try {
            decoder.process(InputImage.fromMediaImage(image, frame.imageInfo.rotationDegrees))
          } catch (_: Exception) {
            /* 解码器已在销毁时关闭：这一帧不会再有回调，必须自己释放 */
            frame.close()
            return@setAnalyzer
          }
          task
            .addOnSuccessListener { barcodes ->
              val value = barcodes.firstNotNullOfOrNull { it.rawValue }
              if (value != null && !completed) {
                completed = true
                setResult(Activity.RESULT_OK, Intent().putExtra("value", value))
                finish()
              }
            }
            .addOnCompleteListener { frame.close() }
        }
        provider.unbindAll()
        provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
      } catch (_: Exception) {
        setResult(Activity.RESULT_CANCELED)
        finish()
      }
    }, ContextCompat.getMainExecutor(this))
  }

  override fun onDestroy() {
    super.onDestroy()
    /* 先停止取帧、等在途帧处理完，再关解码器 */
    completed = true
    cameraProvider?.unbindAll()
    executor.shutdown()
    executor.awaitTermination(500, java.util.concurrent.TimeUnit.MILLISECONDS)
    decoder.close()
  }
}
