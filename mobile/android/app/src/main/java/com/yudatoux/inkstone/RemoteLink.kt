package com.yudatoux.inkstone

import android.util.Base64
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class RemoteReply(val status: Int, val body: String)

class RemoteDenied(message: String) : Exception(message)

interface RemoteLink {
  fun get(path: String): RemoteReply
  fun events(path: String, onLine: (String) -> Boolean): Int
  fun close()
}

class DirectLink(private val baseUrl: String, private val token: String) : RemoteLink {
  @Volatile private var stream: HttpURLConnection? = null

  private fun open(path: String, accept: String, readTimeout: Int) =
    (URL(baseUrl + path).openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      setRequestProperty("Authorization", "Bearer $token")
      setRequestProperty("Accept", accept)
      connectTimeout = 12_000
      this.readTimeout = readTimeout
      useCaches = false
    }

  override fun get(path: String): RemoteReply {
    val connection = open(path, "application/json", 12_000)
    try {
      val status = connection.responseCode
      return RemoteReply(status, if (status == 200) connection.inputStream.bufferedReader().use { it.readText() } else "")
    } finally {
      connection.disconnect()
    }
  }

  override fun events(path: String, onLine: (String) -> Boolean): Int {
    val connection = open(path, "text/event-stream", 65_000)
    stream = connection
    try {
      val status = connection.responseCode
      if (status != 200) return status
      connection.inputStream.bufferedReader().use { reader ->
        while (true) {
          val line = reader.readLine() ?: break
          if (!onLine(line)) break
        }
      }
      return status
    } finally {
      connection.disconnect()
      if (stream === connection) stream = null
    }
  }

  override fun close() {
    stream?.disconnect()
  }
}

class RelayConfig(val join: String, val hostKey: String, val clientKey: String, val clientPub: String) {
  val fingerprint: String get() = join + "|" + clientPub
  val urls: List<String> get() = join.split('\n').map { it.trim() }.filter { it.isNotEmpty() }
}

fun connectRelay(config: RelayConfig, token: String): RelayLink {
  var last: Exception = IOException("没有可用的连接地址")
  for (url in config.urls) {
    val link = RelayLink(config, token, url)
    try {
      link.connect()
      return link
    } catch (error: RemoteDenied) {
      link.close()
      throw error
    } catch (error: Exception) {
      link.close()
      last = error
    }
  }
  throw last
}

class RelayLink(private val config: RelayConfig, private val token: String, private val url: String = config.urls.firstOrNull() ?: config.join) : RemoteLink {
  private sealed class Item {
    class Res(val status: Int, val body: ByteArray, val stream: Boolean) : Item()
    class Chunk(val bytes: ByteArray) : Item()
    class End(val error: String?) : Item()
  }

  private val pending = ConcurrentHashMap<String, LinkedBlockingQueue<Item>>()
  private val ready = CountDownLatch(1)
  private val seq = AtomicInteger()
  private val sendLock = Any()
  @Volatile private var socket: WebSocket? = null
  @Volatile private var failure: Exception? = null
  @Volatile private var opened = false
  private var channel: Channel? = null

  fun connect() {
    val clientSecret = fromB64u(config.clientKey)
    val eph = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    val ephRaw = rawPublic(eph.public as ECPublicKey)
    val listener = object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        webSocket.send(JSONObject().put("t", "hi").put("v", PROTOCOL_VERSION).put("c", config.clientPub).put("e", toB64u(ephRaw)).toString())
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        try {
          val current = channel
          if (current == null) {
            val hi = JSONObject(text)
            if (hi.optString("t") != "hi" || hi.optString("e").isEmpty()) throw IOException("电脑的握手消息不对")
            val next = clientChannel(clientSecret, eph.private, ephRaw, fromB64u(config.hostKey), fromB64u(config.clientPub), fromB64u(hi.getString("e")))
            channel = next
            send(JSONObject().put("t", "auth").put("name", "砚手机端"))
            return
          }
          val msg = current.open(text)
          if (!opened) {
            when (msg.optString("t")) {
              "welcome" -> { opened = true; ready.countDown() }
              "denied" -> fail(RemoteDenied(msg.optString("reason", "电脑拒绝了连接")))
              else -> fail(IOException("电脑的回应不对"))
            }
            return
          }
          frame(msg)
        } catch (error: Exception) {
          fail(error)
        }
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(1000, null)
        fail(IOException(if (code == 4004) "电脑不在线" else "中继连接断开（$code）"))
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        fail(IOException("中继连接断开（$code）"))
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        fail(IOException("连不上中继：${t.message}"))
      }
    }
    socket = http.newWebSocket(Request.Builder().url(url).build(), listener)
    if (!ready.await(HANDSHAKE_MS, TimeUnit.MILLISECONDS)) {
      fail(IOException("中继握手超时"))
    }
    failure?.let { throw it }
  }

  private fun send(msg: JSONObject) {
    synchronized(sendLock) {
      val ws = socket ?: throw IOException("中继连接已关闭")
      val current = channel ?: throw IOException("中继连接未就绪")
      if (!ws.send(current.seal(msg))) throw IOException("中继连接已关闭")
    }
  }

  private fun fail(error: Exception) {
    if (failure == null) failure = error
    socket?.cancel()
    socket = null
    ready.countDown()
    for (queue in pending.values) queue.offer(Item.End(error.message ?: "中继连接断开"))
  }

  private fun frame(msg: JSONObject) {
    if (msg.optString("t") == "ping") return send(JSONObject().put("t", "pong"))
    val queue = pending[msg.optString("id")] ?: return
    when (msg.optString("t")) {
      "res" -> queue.offer(Item.Res(msg.optInt("status", 502), msg.optString("body").takeIf { it.isNotEmpty() }?.let { Base64.decode(it, Base64.DEFAULT) } ?: ByteArray(0), msg.optBoolean("stream")))
      "chunk" -> queue.offer(Item.Chunk(Base64.decode(msg.optString("data"), Base64.DEFAULT)))
      "end" -> queue.offer(Item.End(if (msg.has("error")) msg.optString("error") else null))
    }
  }

  private fun begin(prefix: String, path: String, accept: String): Pair<String, LinkedBlockingQueue<Item>> {
    failure?.let { throw it }
    val id = prefix + seq.incrementAndGet()
    val queue = LinkedBlockingQueue<Item>()
    pending[id] = queue
    val headers = JSONObject().put("authorization", "Bearer $token").put("accept", accept)
    try {
      send(JSONObject().put("t", "req").put("id", id).put("method", "GET").put("path", path).put("headers", headers))
    } catch (error: Exception) {
      pending.remove(id)
      throw error
    }
    return id to queue
  }

  private fun next(id: String, queue: LinkedBlockingQueue<Item>, timeoutMs: Long): Item {
    val item = queue.poll(timeoutMs, TimeUnit.MILLISECONDS)
    if (item == null) {
      pending.remove(id)
      runCatching { send(JSONObject().put("t", "abort").put("id", id)) }
      throw IOException("经中继请求超时")
    }
    if (item is Item.End && item.error != null) {
      pending.remove(id)
      throw IOException(item.error)
    }
    return item
  }

  override fun get(path: String): RemoteReply {
    val (id, queue) = begin("n", path, "application/json")
    try {
      val head = next(id, queue, REQUEST_MS) as? Item.Res ?: throw IOException("电脑的回应不对")
      if (!head.stream) return RemoteReply(head.status, String(head.body, Charsets.UTF_8))
      val body = ByteArrayOutputStream()
      while (true) {
        when (val item = next(id, queue, REQUEST_MS)) {
          is Item.Chunk -> body.write(item.bytes)
          is Item.End -> return RemoteReply(head.status, body.toString("UTF-8"))
          is Item.Res -> throw IOException("电脑的回应不对")
        }
      }
    } finally {
      pending.remove(id)
    }
  }

  override fun events(path: String, onLine: (String) -> Boolean): Int {
    val (id, queue) = begin("e", path, "text/event-stream")
    try {
      val head = next(id, queue, REQUEST_MS) as? Item.Res ?: throw IOException("电脑的回应不对")
      if (head.status != 200 || !head.stream) return head.status
      var carry = ByteArray(0)
      while (true) {
        when (val item = next(id, queue, STREAM_IDLE_MS)) {
          is Item.Chunk -> {
            val all = carry + item.bytes
            var start = 0
            for (index in all.indices) {
              if (all[index] != NEWLINE) continue
              val line = String(all, start, index - start, Charsets.UTF_8).trimEnd('\r')
              start = index + 1
              if (!onLine(line)) {
                runCatching { send(JSONObject().put("t", "abort").put("id", id)) }
                return head.status
              }
            }
            carry = all.copyOfRange(start, all.size)
          }
          is Item.End -> return head.status
          is Item.Res -> throw IOException("电脑的回应不对")
        }
      }
    } finally {
      pending.remove(id)
    }
  }

  override fun close() {
    fail(IOException("连接已关闭"))
  }

  private class Channel(private val sendKey: ByteArray, private val recvKey: ByteArray) {
    private var sendCount = 0L
    private var recvCount = 0L

    private fun cipher(mode: Int, key: ByteArray, counter: ByteArray): Cipher =
      Cipher.getInstance("AES/GCM/NoPadding").apply { init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, ByteArray(4) + counter)) }

    fun seal(msg: JSONObject): String {
      val counter = ByteBuffer.allocate(8).putLong(sendCount++).array()
      return "x." + toB64u(counter + cipher(Cipher.ENCRYPT_MODE, sendKey, counter).doFinal(msg.toString().toByteArray(Charsets.UTF_8)))
    }

    fun open(frame: String): JSONObject {
      if (!frame.startsWith("x.")) throw IOException("不是加密帧")
      val bytes = fromB64u(frame.substring(2))
      if (bytes.size < 24) throw IOException("加密帧太短")
      val counter = bytes.copyOfRange(0, 8)
      if (ByteBuffer.wrap(counter).long != recvCount) throw IOException("加密帧计数不对")
      val plain = cipher(Cipher.DECRYPT_MODE, recvKey, counter).doFinal(bytes, 8, bytes.size - 8)
      recvCount++
      return JSONObject(String(plain, Charsets.UTF_8))
    }
  }

  companion object {
    private const val PROTOCOL_VERSION = 1
    private const val HANDSHAKE_MS = 15_000L
    private const val REQUEST_MS = 20_000L
    private const val STREAM_IDLE_MS = 65_000L
    private const val NEWLINE = '\n'.code.toByte()
    private val LABEL = "reef-v1".toByteArray(Charsets.UTF_8)
    private val INFO = "reef-v1 keys".toByteArray(Charsets.UTF_8)
    private val http by lazy { OkHttpClient.Builder().connectTimeout(12, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build() }
    private val curve: ECParameterSpec by lazy {
      AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
    }

    fun toB64u(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    fun fromB64u(text: String): ByteArray = Base64.decode(text, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    private fun fixed(value: BigInteger): ByteArray {
      val bytes = value.toByteArray()
      return when {
        bytes.size == 32 -> bytes
        bytes.size > 32 -> bytes.copyOfRange(bytes.size - 32, bytes.size)
        else -> ByteArray(32 - bytes.size) + bytes
      }
    }

    private fun rawPublic(key: ECPublicKey): ByteArray = byteArrayOf(4) + fixed(key.w.affineX) + fixed(key.w.affineY)

    private fun importPublic(raw: ByteArray): PublicKey {
      if (raw.size != 65 || raw[0] != 4.toByte()) throw IOException("公钥格式不对")
      val point = ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65)))
      return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, curve))
    }

    private fun importPrivate(raw: ByteArray): PrivateKey =
      KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, raw), curve))

    private fun ecdh(privateKey: PrivateKey, publicKey: PublicKey): ByteArray =
      KeyAgreement.getInstance("ECDH").run {
        init(privateKey)
        doPhase(publicKey, true)
        generateSecret()
      }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
      Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        doFinal(data)
      }

    private fun clientChannel(clientSecret: ByteArray, ephPrivate: PrivateKey, ephRaw: ByteArray, hostRaw: ByteArray, clientRaw: ByteArray, hostEphRaw: ByteArray): Channel {
      val hostStatic = importPublic(hostRaw)
      val hostEph = importPublic(hostEphRaw)
      val ikm = ecdh(ephPrivate, hostEph) + ecdh(ephPrivate, hostStatic) + ecdh(importPrivate(clientSecret), hostEph)
      val salt = MessageDigest.getInstance("SHA-256").digest(LABEL + hostRaw + clientRaw + ephRaw + hostEphRaw)
      val prk = hmac(salt, ikm)
      val first = hmac(prk, INFO + byteArrayOf(1))
      val okm = first + hmac(prk, first + INFO + byteArrayOf(2))
      return Channel(okm.copyOfRange(0, 32), okm.copyOfRange(32, 64))
    }
  }
}
