package dev.kkirner.audiobook.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

class BookRepository(private val context: Context) {

    private val json = Json { ignoreUnknownKeys = true }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val prefs by lazy {
        context.getSharedPreferences("audiobook", Context.MODE_PRIVATE)
    }

    val serverUrl: String
        get() = prefs.getString("server_url", "") ?: ""

    val authToken: String
        get() = prefs.getString("auth_token", "") ?: ""

    fun saveServer(url: String, token: String) {
        prefs.edit().putString("server_url", url.trimEnd('/'))
            .putString("auth_token", token).apply()
    }

    private fun booksDir(): File {
        val dir = File(context.filesDir, "books")
        dir.mkdirs()
        return dir
    }

    fun bookDir(bookId: String): File {
        val dir = File(booksDir(), bookId)
        File(dir, "audio").mkdirs()
        return dir
    }

    private fun manifestFile(bookId: String) = File(bookDir(bookId), "manifest.json")

    private fun authHeaders(builder: Request.Builder): Request.Builder {
        if (authToken.isNotEmpty()) {
            builder.addHeader("Authorization", "Bearer $authToken")
        }
        return builder
    }

    suspend fun fetchBooks(): List<BookSummary> = withContext(Dispatchers.IO) {
        val req = authHeaders(Request.Builder().url("$serverUrl/api/books")).build()
        val body = client.newCall(req).execute().use { it.body?.string() ?: "[]" }
        json.decodeFromString<List<BookSummary>>(body)
    }

    suspend fun fetchManifest(bookId: String): BookManifest = withContext(Dispatchers.IO) {
        val req = authHeaders(Request.Builder().url("$serverUrl/api/books/$bookId")).build()
        val body = client.newCall(req).execute().use { it.body?.string() ?: "{}" }
        json.decodeFromString<BookManifest>(body)
    }

    suspend fun downloadBook(bookId: String, onProgress: (Int, Int) -> Unit): BookManifest =
        withContext(Dispatchers.IO) {
            val manifest = fetchManifest(bookId)
            val dir = bookDir(bookId)

            // Save manifest locally
            File(dir, "manifest.json").writeText(json.encodeToString(manifest))

            val generated = manifest.chunks.filter { it.generated }
            var done = 0

            for (chunk in generated) {
                val audioFile = File(dir, "audio/${chunk.audioFile}")
                if (audioFile.exists() && audioFile.length() > 0) {
                    done++
                    onProgress(done, generated.size)
                    continue
                }
                val url = "$serverUrl/api/books/$bookId/audio/${chunk.audioFile}"
                val req = authHeaders(Request.Builder().url(url)).build()
                client.newCall(req).execute().use { resp ->
                    if (resp.isSuccessful) {
                        resp.body?.byteStream()?.use { input ->
                            audioFile.outputStream().use { output -> input.copyTo(output) }
                        }
                    }
                }
                done++
                onProgress(done, generated.size)
            }

            manifest
        }

    fun getLocalManifest(bookId: String): BookManifest? {
        val file = manifestFile(bookId)
        if (!file.exists()) return null
        return try {
            json.decodeFromString<BookManifest>(file.readText())
        } catch (e: Exception) {
            null
        }
    }

    fun getLocalBooks(): List<BookManifest> {
        val dir = booksDir()
        if (!dir.exists()) return emptyList()
        return dir.listFiles()?.mapNotNull { bookDir ->
            val mf = File(bookDir, "manifest.json")
            if (mf.exists()) {
                try { json.decodeFromString<BookManifest>(mf.readText()) } catch (e: Exception) { null }
            } else null
        }?.sortedByDescending { it.createdAt } ?: emptyList()
    }

    fun audioFile(bookId: String, chunkAudioFile: String): File {
        return File(bookDir(bookId), "audio/$chunkAudioFile")
    }

    fun deleteLocalBook(bookId: String) {
        bookDir(bookId).deleteRecursively()
    }

    // Playback position persistence
    fun savePosition(bookId: String, chunkIdx: Int, positionMs: Long) {
        prefs.edit()
            .putInt("pos_chunk_$bookId", chunkIdx)
            .putLong("pos_ms_$bookId", positionMs)
            .apply()
    }

    fun getPosition(bookId: String): Pair<Int, Long> {
        val chunk = prefs.getInt("pos_chunk_$bookId", 0)
        val ms = prefs.getLong("pos_ms_$bookId", 0L)
        return chunk to ms
    }
}
