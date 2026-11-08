package com.yudatoux.inkstone

import android.util.Base64
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.nio.ByteBuffer
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class RelayCryptoModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "InkstoneRelayCrypto"

  private val flags = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP

  private fun cipher(mode: Int, key: String, counter: Long): Cipher {
    val iv = ByteBuffer.allocate(12).putInt(0).putLong(counter).array()
    return Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(mode, SecretKeySpec(Base64.decode(key, flags), "AES"), GCMParameterSpec(128, iv))
    }
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun open(key: String, frame: String, expected: Double): String {
    if (!frame.startsWith("x.")) throw IllegalArgumentException("not an encrypted frame")
    val bytes = Base64.decode(frame.substring(2), flags)
    if (bytes.size < 24) throw IllegalArgumentException("encrypted frame too short")
    val counter = ByteBuffer.wrap(bytes, 0, 8).long
    if (counter != expected.toLong()) throw IllegalArgumentException("encrypted frame count mismatch")
    val plain = cipher(Cipher.DECRYPT_MODE, key, counter).doFinal(bytes, 8, bytes.size - 8)
    return String(plain, Charsets.UTF_8)
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun seal(key: String, counter: Double, text: String): String {
    val n = counter.toLong()
    val sealed = cipher(Cipher.ENCRYPT_MODE, key, n).doFinal(text.toByteArray(Charsets.UTF_8))
    val out = ByteBuffer.allocate(8 + sealed.size).putLong(n).put(sealed).array()
    return "x." + Base64.encodeToString(out, flags)
  }
}
