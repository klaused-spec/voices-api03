package dev.kkirner.audiobook.playback

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import dev.kkirner.audiobook.PlayerActivity
import dev.kkirner.audiobook.data.BookManifest
import dev.kkirner.audiobook.data.BookRepository
import java.io.File

class PlaybackService : MediaSessionService() {

    private var mediaSession: MediaSession? = null
    private var player: ExoPlayer? = null
    private lateinit var repo: BookRepository

    companion object {
        const val CHANNEL_ID = "audiobook_playback"
        const val NOTIFICATION_ID = 1
        const val ACTION_PLAY_BOOK = "dev.kkirner.audiobook.PLAY_BOOK"
        const val EXTRA_BOOK_ID = "book_id"

        var currentBookId: String? = null
            private set
        var currentManifest: BookManifest? = null
            private set
    }

    @OptIn(UnstableApi::class)
    override fun onCreate() {
        super.onCreate()
        repo = BookRepository(this)
        createNotificationChannel()

        player = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                    .setUsage(C.USAGE_MEDIA)
                    .build(),
                true // handleAudioFocus
            )
            .setHandleAudioBecomingNoisy(true)
            .build()

        val intent = Intent(this, PlayerActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        mediaSession = MediaSession.Builder(this, player!!)
            .setSessionActivity(pendingIntent)
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? {
        return mediaSession
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_PLAY_BOOK) {
            val bookId = intent.getStringExtra(EXTRA_BOOK_ID) ?: return super.onStartCommand(intent, flags, startId)
            loadBook(bookId)
        }
        return super.onStartCommand(intent, flags, startId)
    }

    private fun loadBook(bookId: String) {
        val manifest = repo.getLocalManifest(bookId) ?: return
        val generatedChunks = manifest.chunks.filter { it.generated }
        if (generatedChunks.isEmpty()) return

        currentBookId = bookId
        currentManifest = manifest

        val p = player ?: return
        p.stop()
        p.clearMediaItems()

        val mediaItems = generatedChunks.map { chunk ->
            val file = repo.audioFile(bookId, chunk.audioFile)
            MediaItem.Builder()
                .setUri(Uri.fromFile(file))
                .setMediaId("${bookId}:${chunk.id}")
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(manifest.title)
                        .setArtist("Parágrafo ${chunk.id}")
                        .setExtras(Bundle().apply {
                            putInt("chunk_id", chunk.id)
                            putString("chunk_text", chunk.text)
                        })
                        .build()
                )
                .build()
        }

        p.setMediaItems(mediaItems)

        // Restore position
        val (chunkIdx, posMs) = repo.getPosition(bookId)
        if (chunkIdx in mediaItems.indices) {
            p.seekTo(chunkIdx, posMs)
        }

        p.prepare()
        p.play()
    }

    fun seekToChunk(index: Int) {
        player?.seekTo(index, 0)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Audiobook Playback",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Reprodução de audiobook em andamento"
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        // Save position before destroying
        val p = player
        val bookId = currentBookId
        if (p != null && bookId != null) {
            repo.savePosition(bookId, p.currentMediaItemIndex, p.currentPosition)
        }

        mediaSession?.run {
            player.release()
            release()
            mediaSession = null
        }
        player = null
        currentBookId = null
        currentManifest = null
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = player ?: return super.onTaskRemoved(rootIntent)
        if (!p.playWhenReady || p.mediaItemCount == 0) {
            stopSelf()
        }
        super.onTaskRemoved(rootIntent)
    }
}
