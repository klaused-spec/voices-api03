package dev.kkirner.audiobook

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.SeekBar
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import dev.kkirner.audiobook.data.BookManifest
import dev.kkirner.audiobook.data.BookRepository
import dev.kkirner.audiobook.data.Chunk
import dev.kkirner.audiobook.databinding.ActivityPlayerBinding
import dev.kkirner.audiobook.playback.PlaybackService
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class PlayerActivity : ComponentActivity() {

    private lateinit var binding: ActivityPlayerBinding
    private lateinit var repo: BookRepository
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private var chunkAdapter: ChunkAdapter? = null
    private var positionJob: Job? = null
    private var bookId: String? = null
    private var manifest: BookManifest? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPlayerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        repo = BookRepository(this)
        bookId = intent.getStringExtra("book_id")

        if (bookId == null) {
            finish()
            return
        }

        setupUI()
        downloadAndPlay()
    }

    private fun setupUI() {
        binding.btnBack.setOnClickListener { finish() }

        binding.btnPlayPause.setOnClickListener {
            val c = controller ?: return@setOnClickListener
            if (c.isPlaying) c.pause() else c.play()
        }

        binding.btnPrev.setOnClickListener {
            val c = controller ?: return@setOnClickListener
            if (c.currentPosition > 3000) c.seekTo(0) else c.seekToPreviousMediaItem()
        }

        binding.btnNext.setOnClickListener {
            controller?.seekToNextMediaItem()
        }

        binding.btnRewind.setOnClickListener {
            val c = controller ?: return@setOnClickListener
            c.seekTo(maxOf(0, c.currentPosition - 10_000))
        }

        binding.btnForward.setOnClickListener {
            val c = controller ?: return@setOnClickListener
            c.seekTo(c.currentPosition + 30_000)
        }

        binding.seekBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                if (fromUser) controller?.seekTo(progress.toLong())
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {}
        })

        binding.speedChip.setOnClickListener { cycleSpeed() }

        chunkAdapter = ChunkAdapter { chunkIndex ->
            controller?.seekTo(chunkIndex, 0)
        }
        binding.chunkRecycler.apply {
            layoutManager = LinearLayoutManager(this@PlayerActivity)
            adapter = chunkAdapter
        }
    }

    private fun downloadAndPlay() {
        val id = bookId ?: return
        binding.progressLayout.visibility = View.VISIBLE
        binding.playerControls.visibility = View.GONE

        lifecycleScope.launch {
            try {
                binding.downloadStatus.text = "Baixando livro..."
                val m = repo.downloadBook(id) { done, total ->
                    runOnUiThread {
                        binding.downloadProgress.max = total
                        binding.downloadProgress.progress = done
                        binding.downloadStatus.text = "Baixando: $done/$total áudios"
                    }
                }
                manifest = m

                binding.progressLayout.visibility = View.GONE
                binding.playerControls.visibility = View.VISIBLE
                binding.bookTitle.text = m.title
                binding.chunkCount.text = "${m.chunks.count { it.generated }} parágrafos"

                val generated = m.chunks.filter { it.generated }
                chunkAdapter?.submitList(generated)

                startPlayback(id)
            } catch (e: Exception) {
                Toast.makeText(this@PlayerActivity, "Erro: ${e.message}", Toast.LENGTH_LONG).show()
                binding.downloadStatus.text = "Erro ao baixar: ${e.message}"
            }
        }
    }

    private fun startPlayback(bookId: String) {
        val serviceIntent = Intent(this, PlaybackService::class.java).apply {
            action = PlaybackService.ACTION_PLAY_BOOK
            putExtra(PlaybackService.EXTRA_BOOK_ID, bookId)
        }
        startService(serviceIntent)

        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        controllerFuture = MediaController.Builder(this, token).buildAsync()
        controllerFuture?.addListener({
            controller = controllerFuture?.let {
                try { it.get() } catch (e: Exception) { null }
            }
            controller?.let { connectPlayer(it) }
        }, MoreExecutors.directExecutor())
    }

    private fun connectPlayer(c: MediaController) {
        c.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                runOnUiThread { updatePlayPauseButton(isPlaying) }
            }

            override fun onMediaItemTransition(
                mediaItem: androidx.media3.common.MediaItem?,
                reason: Int
            ) {
                runOnUiThread { updateCurrentChunk() }
            }

            override fun onPlaybackStateChanged(state: Int) {
                runOnUiThread {
                    if (state == Player.STATE_ENDED) {
                        updatePlayPauseButton(false)
                    }
                }
            }
        })

        updatePlayPauseButton(c.isPlaying)
        updateCurrentChunk()
        startPositionUpdates()
    }

    private fun updatePlayPauseButton(isPlaying: Boolean) {
        binding.btnPlayPause.text = if (isPlaying) "⏸" else "▶"
    }

    private fun updateCurrentChunk() {
        val c = controller ?: return
        val idx = c.currentMediaItemIndex
        chunkAdapter?.setCurrentIndex(idx)

        // Scroll to current chunk
        val layoutManager = binding.chunkRecycler.layoutManager as? LinearLayoutManager
        layoutManager?.scrollToPositionWithOffset(idx, binding.chunkRecycler.height / 3)

        // Save position
        bookId?.let { repo.savePosition(it, idx, c.currentPosition) }
    }

    private fun startPositionUpdates() {
        positionJob?.cancel()
        positionJob = lifecycleScope.launch {
            while (isActive) {
                val c = controller
                if (c != null && c.isPlaying) {
                    val pos = c.currentPosition
                    val dur = c.duration
                    runOnUiThread {
                        binding.seekBar.max = dur.toInt().coerceAtLeast(0)
                        binding.seekBar.progress = pos.toInt().coerceAtLeast(0)
                        binding.timePosition.text = formatTime(pos)
                        binding.timeDuration.text = formatTime(dur)
                    }
                    // Save position periodically
                    bookId?.let { repo.savePosition(it, c.currentMediaItemIndex, pos) }
                }
                delay(500)
            }
        }
    }

    private var speedIndex = 2 // 1.0x default
    private val speeds = floatArrayOf(0.75f, 0.9f, 1.0f, 1.15f, 1.25f, 1.5f, 1.75f, 2.0f)

    private fun cycleSpeed() {
        speedIndex = (speedIndex + 1) % speeds.size
        val speed = speeds[speedIndex]
        controller?.setPlaybackSpeed(speed)
        binding.speedChip.text = "${speed}x"
    }

    private fun formatTime(ms: Long): String {
        if (ms < 0) return "0:00"
        val totalSec = ms / 1000
        val min = totalSec / 60
        val sec = totalSec % 60
        return "%d:%02d".format(min, sec)
    }

    override fun onStop() {
        super.onStop()
        val c = controller
        if (c != null) {
            bookId?.let { repo.savePosition(it, c.currentMediaItemIndex, c.currentPosition) }
        }
    }

    override fun onDestroy() {
        positionJob?.cancel()
        controllerFuture?.let { MediaController.releaseFuture(it) }
        super.onDestroy()
    }
}
