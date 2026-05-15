package dev.kkirner.audiobook

import android.graphics.Color
import android.graphics.Typeface
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import dev.kkirner.audiobook.data.Chunk

class ChunkAdapter(
    private val onChunkClick: (Int) -> Unit
) : ListAdapter<Chunk, ChunkAdapter.VH>(DIFF) {

    private var currentIndex = -1

    fun setCurrentIndex(index: Int) {
        val old = currentIndex
        currentIndex = index
        if (old >= 0 && old < itemCount) notifyItemChanged(old)
        if (index >= 0 && index < itemCount) notifyItemChanged(index)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val tv = TextView(parent.context).apply {
            layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 0, 0, 2)
            }
            setPadding(48, 24, 48, 24)
            textSize = 15f
            setLineSpacing(8f, 1f)
        }
        return VH(tv)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val chunk = getItem(position)
        val tv = holder.itemView as TextView
        tv.text = chunk.text

        val isCurrent = position == currentIndex
        if (isCurrent) {
            tv.setBackgroundColor(Color.parseColor("#1a7c3aed"))
            tv.setTextColor(Color.parseColor("#e2e2e8"))
            tv.setTypeface(null, Typeface.NORMAL)
            // Left accent bar
            tv.compoundDrawablePadding = 0
        } else {
            tv.setBackgroundColor(Color.TRANSPARENT)
            tv.setTextColor(Color.parseColor("#9999aa"))
            tv.setTypeface(null, Typeface.NORMAL)
        }

        tv.setOnClickListener { onChunkClick(position) }
    }

    class VH(view: View) : RecyclerView.ViewHolder(view)

    companion object {
        val DIFF = object : DiffUtil.ItemCallback<Chunk>() {
            override fun areItemsTheSame(a: Chunk, b: Chunk) = a.id == b.id
            override fun areContentsTheSame(a: Chunk, b: Chunk) = a == b
        }
    }
}
