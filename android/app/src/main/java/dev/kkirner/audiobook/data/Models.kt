package dev.kkirner.audiobook.data

import kotlinx.serialization.Serializable

@Serializable
data class BookManifest(
    val id: String,
    val title: String,
    val voice: String,
    val model: String = "",
    val totalChunks: Int,
    val generatedChunks: Int = 0,
    val status: String = "",
    val createdAt: String = "",
    val chunks: List<Chunk> = emptyList()
)

@Serializable
data class Chunk(
    val id: Int,
    val text: String,
    val audioFile: String,
    val generated: Boolean = false
)

@Serializable
data class BookSummary(
    val id: String,
    val title: String,
    val voice: String = "",
    val totalChunks: Int = 0,
    val generatedChunks: Int = 0,
    val status: String = ""
)
