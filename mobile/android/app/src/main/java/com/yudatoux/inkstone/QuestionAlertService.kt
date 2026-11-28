package com.yudatoux.inkstone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import org.json.JSONObject
import java.security.MessageDigest

/**
 * Keeps the paired desktop's question events reachable while the phone UI is in the background.
 * Only question IDs are stored locally. Task titles stay private on the lock screen.
 */
class QuestionAlertService : Service() {
  private val manager by lazy { getSystemService(NotificationManager::class.java) }
  private val preferences by lazy { getSharedPreferences("inkstone.question.alerts", MODE_PRIVATE) }
  @Volatile private var running = false
  @Volatile private var generation = 0
  @Volatile private var link: RemoteLink? = null
  private var worker: Thread? = null
  private var known = emptySet<String>()
  private var questionSession: String? = null
  private var ongoingKey = ""
  private var lastStatusAt = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    manager.createNotificationChannel(NotificationChannel(SERVICE_CHANNEL, "电脑连接", NotificationManager.IMPORTANCE_LOW))
    manager.createNotificationChannel(NotificationChannel(QUESTION_CHANNEL, "待回答问题", NotificationManager.IMPORTANCE_HIGH).apply { enableVibration(true) })
    manager.deleteNotificationChannel(HUB_CHANNEL)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopMonitoring(clear = true)
      stopSelf()
      return START_NOT_STICKY
    }
    val baseUrl = intent?.getStringExtra(EXTRA_BASE_URL)?.trimEnd('/')
    val token = intent?.getStringExtra(EXTRA_TOKEN)
    val relay = intent?.let { relayConfig(it) }
    if (baseUrl.isNullOrBlank() || token.isNullOrBlank() || relay == null || !manager.areNotificationsEnabled()) {
      promoteToForeground(ongoingNotification("砚", "已停止"))
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    stopWorker()
    val identity = MessageDigest.getInstance("SHA-256")
      .digest("$baseUrl:$token:${relay.fingerprint}".toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }
    if (preferences.getString("identity", null) != identity) {
      preferences.edit().putString("identity", identity).remove("known").apply()
      manager.cancel(QUESTION_ID)
    }
    known = preferences.getStringSet("known", emptySet())?.toSet() ?: emptySet()

    ongoingKey = ""
    if (!promoteToForeground(ongoingNotification("砚", "连接中"))) {
      stopSelf()
      return START_NOT_STICKY
    }

    running = true
    active = true
    val current = generation
    worker = Thread({ monitor(token, relay, current) }, "InkstoneQuestionAlerts").also { it.start() }
    return START_REDELIVER_INTENT
  }

  private fun promoteToForeground(notification: Notification): Boolean = try {
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(SERVICE_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
    } else {
      startForeground(SERVICE_ID, notification)
    }
    true
  } catch (error: Exception) {
    Log.w(TAG, "startForeground: ${error.message}")
    false
  }

  private fun relayConfig(intent: Intent): RelayConfig? {
    val join = intent.getStringExtra(EXTRA_RELAY_JOIN)
    val hostKey = intent.getStringExtra(EXTRA_RELAY_HOST_KEY)
    val clientKey = intent.getStringExtra(EXTRA_RELAY_CLIENT_KEY)
    val clientPub = intent.getStringExtra(EXTRA_RELAY_CLIENT_PUB)
    if (join.isNullOrBlank() || hostKey.isNullOrBlank() || clientKey.isNullOrBlank() || clientPub.isNullOrBlank()) return null
    return RelayConfig(join, hostKey, clientKey, clientPub)
  }

  private fun monitor(token: String, relay: RelayConfig, current: Int) {
    var retryMs = 1_000L
    while (running && generation == current) {
      var currentLink: RemoteLink? = null
      try {
        currentLink = connectRelay(relay, token)
        link = currentLink
        if (!running || generation != current) break
        syncQuestions(currentLink, current)
        syncTask(currentLink, current)
        if (!running || generation != current) break
        val status = currentLink.events("/remote/v1/events?since=0") { line ->
          if (line.startsWith("event:")) {
            when (line.substringAfter(':').trim()) {
              "ui-request", "ui-resolved", "ui-deadline", "resync" -> {
                syncQuestions(currentLink, current)
                syncTask(currentLink, current)
              }
              "runners", "proc", "session-title" -> syncTask(currentLink, current)
              "state" -> if (System.currentTimeMillis() - lastStatusAt >= 1000) syncTask(currentLink, current)
            }
          } else if (line.startsWith(":")) {
            syncTask(currentLink, current)
          }
          running && generation == current
        }
        if (status == 401) throw RemoteDenied("events: 401")
        if (status != 200) throw IllegalStateException("events: $status")
        retryMs = 1_000L
      } catch (_: RemoteDenied) {
        stopSelf()
        return
      } catch (error: Exception) {
        if (running && generation == current) Log.w(TAG, "relay: ${error.message}")
        updateOngoing("砚", "重新连接中", current)
      } finally {
        currentLink?.close()
        if (link === currentLink) link = null
      }
      if (!running || generation != current) break
      try { Thread.sleep(retryMs) } catch (_: InterruptedException) { break }
      retryMs = (retryMs * 2).coerceAtMost(30_000L)
    }
  }

  private fun syncQuestions(link: RemoteLink, currentGeneration: Int) {
    val reply = link.call("questions")
    run {
      if (reply.status == 401) throw RemoteDenied("questions: 401")
      if (reply.status != 200) return
      val array = JSONObject(reply.body)
        .getJSONObject("data").getJSONArray("questions")
      val current = buildSet {
        for (index in 0 until array.length()) add(array.getJSONObject(index).getString("id"))
      }
      if (!running || generation != currentGeneration) return
      questionSession = if (array.length() > 0) array.getJSONObject(0).optString("sessionId").takeIf { it.isNotBlank() && it != "null" } else null
      val hasNew = current.any { it !in known }
      known = current
      preferences.edit().putStringSet("known", current).apply()
      if (current.isEmpty()) {
        manager.cancel(QUESTION_ID)
      } else {
        val notification = Notification.Builder(this, QUESTION_CHANNEL)
          .setSmallIcon(R.drawable.ic_stat_inkstone).setColor(ACCENT)
          .setContentTitle("砚需要你回答")
          .setContentText("${current.size} 个问题待回答")
          .setContentIntent(openAppIntent())
          .setCategory(Notification.CATEGORY_MESSAGE)
          .setVisibility(Notification.VISIBILITY_PRIVATE)
          .setOnlyAlertOnce(!hasNew)
          .setAutoCancel(false)
          .build()
        manager.notify(QUESTION_ID, notification)
      }
    }
  }

  private fun syncTask(link: RemoteLink, current: Int) {
    val reply = link.call("status")
    run {
      if (reply.status == 401) throw RemoteDenied("status: 401")
      if (reply.status != 200) return
      val snapshot = JSONObject(reply.body).getJSONObject("data")
      val agent = snapshot.optJSONObject("agent")
      val runners = agent?.optJSONArray("runners")
      val activeId = agent?.optString("activeSessionId")
      val tasks = buildList {
        if (runners != null) for (i in 0 until runners.length()) {
          val runner = runners.getJSONObject(i)
          if (runner.optBoolean("running") || runner.optBoolean("waiting")) add(runner)
        }
      }
      val task = tasks.find { it.optString("sessionId") == activeId } ?: tasks.firstOrNull()
      val waiting = known.isNotEmpty() || task?.optBoolean("waiting") == true
      val sessionId = if (known.isNotEmpty()) questionSession else task?.optString("sessionId")
      val sessions = snapshot.optJSONArray("sessions")
      var title = "砚"
      if (sessionId != null && sessions != null) for (i in 0 until sessions.length()) {
        val session = sessions.getJSONObject(i)
        if (session.optString("id") == sessionId) {
          title = session.optString("title").trim().take(80).ifEmpty { "砚" }
          break
        }
      }
      val state = when {
        waiting -> "等你回答"
        tasks.isNotEmpty() -> "运行中" + if (tasks.size > 1) " · ${tasks.size} 个任务" else ""
        else -> "已连接"
      }
      updateOngoing(title, state, current)
      lastStatusAt = System.currentTimeMillis()
    }
  }

  private fun ongoingNotification(title: String, state: String): Notification = Notification.Builder(this, SERVICE_CHANNEL)
    .setSmallIcon(R.drawable.ic_stat_inkstone).setColor(ACCENT)
    .setContentTitle(title)
    .setContentText(state)
    .setContentIntent(openAppIntent())
    .setOngoing(true)
    .setOnlyAlertOnce(true)
    .setVisibility(Notification.VISIBILITY_PRIVATE)
    .setPublicVersion(Notification.Builder(this, SERVICE_CHANNEL).setSmallIcon(R.drawable.ic_stat_inkstone).setColor(ACCENT).setContentTitle("砚").setContentText(state).build())
    .build()

  private fun updateOngoing(title: String, state: String, current: Int) {
    if (!running || generation != current) return
    val key = "$title:$state"
    if (key == ongoingKey) return
    ongoingKey = key
    manager.notify(SERVICE_ID, ongoingNotification(title, state))
  }

  private fun openAppIntent(): PendingIntent {
    val intent = Intent(this, MainActivity::class.java).apply {
      data = android.net.Uri.parse("inkstone://inbox")
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun stopWorker() {
    running = false
    active = false
    generation++
    link?.close()
    worker?.interrupt()
    worker = null
  }

  private fun stopMonitoring(clear: Boolean) {
    stopWorker()
    manager.cancel(QUESTION_ID)
    if (clear) preferences.edit().clear().apply()
  }

  override fun onDestroy() {
    stopMonitoring(clear = false)
    super.onDestroy()
  }

  companion object {
    @Volatile var active = false
    const val ACTION_STOP = "com.yudatoux.inkstone.STOP_QUESTION_ALERTS"
    const val EXTRA_BASE_URL = "baseUrl"
    const val EXTRA_TOKEN = "token"
    const val EXTRA_RELAY_JOIN = "relayJoin"
    const val EXTRA_RELAY_HOST_KEY = "relayHostKey"
    const val EXTRA_RELAY_CLIENT_KEY = "relayClientKey"
    const val EXTRA_RELAY_CLIENT_PUB = "relayClientPub"
    private const val TAG = "InkstoneAlerts"
    private const val SERVICE_CHANNEL = "inkstone.connection"
    private const val QUESTION_CHANNEL = "inkstone.questions"
    private const val HUB_CHANNEL = "inkstone.hub"
    private const val SERVICE_ID = 37921
    private const val QUESTION_ID = 37922
    /** 浅色主题强调色（tokens.css --accent），通知标题与小图标的着色 */
    private val ACCENT = 0xFF5264C8.toInt()
  }
}
