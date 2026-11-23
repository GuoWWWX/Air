package app.air.android

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Native launch overlay matching the desktop splash screen (72dp floating logo with halo,
 * "Air Proxy" title, and sliding gradient progress bar) on a dark/light theme background.
 */
internal class SplashOverlay(context: Context, initialDark: Boolean) : FrameLayout(context) {
    private val loopAnimators = mutableListOf<ValueAnimator>()
    private var started = false
    private var dismissing = false
    private var dismissFallback: Runnable? = null

    private val glowDrawable = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        gradientType = GradientDrawable.RADIAL_GRADIENT
        setGradientCenter(0.5f, 0.5f)
        gradientRadius = dp(46).toFloat()
    }

    private val glowView = View(context).apply {
        background = glowDrawable
        alpha = 0f
    }

    private val logoView = ImageView(context).apply {
        setImageResource(R.mipmap.ic_air)
        scaleType = ImageView.ScaleType.FIT_CENTER
    }

    private val titleView = TextView(context).apply {
        text = "Air Proxy"
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        typeface = Typeface.DEFAULT_BOLD
        letterSpacing = -0.03f
        gravity = Gravity.CENTER_HORIZONTAL
    }

    private val progressBar = SplashProgressBar(context)

    private val footer = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        alpha = 0f
        translationY = dp(8).toFloat()
        addView(titleView, LinearLayout.LayoutParams(-2, -2))
        addView(progressBar, LinearLayout.LayoutParams(dp(96), dp(3)).apply {
            topMargin = dp(14)
        })
    }

    init {
        isClickable = true
        isFocusable = true
        addView(glowView, LayoutParams(dp(104), dp(104)))
        addView(logoView, LayoutParams(dp(72), dp(72)))
        addView(footer, LayoutParams(-2, -2))
        applyTheme(initialDark)
    }

    fun applyTheme(dark: Boolean) {
        setBackgroundColor(if (dark) DARK_BG else LIGHT_BG)
        val glowColors = if (dark) {
            intArrayOf(Color.argb(66, 163, 184, 255), Color.argb(0, 163, 184, 255))
        } else {
            intArrayOf(Color.argb(62, 32, 93, 215), Color.argb(0, 32, 93, 215))
        }
        glowDrawable.colors = glowColors
        titleView.setTextColor(if (dark) DARK_INK else LIGHT_INK)
        progressBar.applyTheme(dark)
    }

    fun startAnimations() {
        if (started || dismissing) return
        started = true
        if (!ValueAnimator.areAnimatorsEnabled()) {
            glowView.alpha = 0.85f
            footer.alpha = 1f
            footer.translationY = 0f
            progressBar.setStaticMode(true)
            return
        }
        val enterEase = PathInterpolator(0.22f, 1f, 0.36f, 1f)
        glowView.animate()
            .alpha(0.85f)
            .setDuration(260L)
            .setInterpolator(enterEase)
            .start()
        footer.animate()
            .alpha(1f)
            .translationY(0f)
            .setDuration(280L)
            .setInterpolator(enterEase)
            .start()

        val wave = AccelerateDecelerateInterpolator()
        val glowLoop = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 2200L
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.REVERSE
            interpolator = wave
            addUpdateListener { anim ->
                val t = anim.animatedValue as Float
                val scale = 0.94f + 0.16f * t
                glowView.scaleX = scale
                glowView.scaleY = scale
                glowView.alpha = 0.65f + 0.35f * t
            }
            start()
        }
        val floatDistance = dp(4).toFloat()
        val floatLoop = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 2400L
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.REVERSE
            interpolator = wave
            addUpdateListener { anim ->
                val t = anim.animatedValue as Float
                logoView.translationY = -floatDistance * t
                val scale = 1f + 0.03f * t
                logoView.scaleX = scale
                logoView.scaleY = scale
            }
            start()
        }
        val progressLoop = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1150L
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.RESTART
            interpolator = wave
            addUpdateListener { anim ->
                progressBar.setSweepFraction(anim.animatedValue as Float)
            }
            start()
        }
        loopAnimators.add(glowLoop)
        loopAnimators.add(floatLoop)
        loopAnimators.add(progressLoop)
    }

    fun stopAnimations() {
        dismissFallback?.let(::removeCallbacks)
        dismissFallback = null
        loopAnimators.forEach { it.cancel() }
        loopAnimators.clear()
        glowView.animate().cancel()
        logoView.animate().cancel()
        footer.animate().cancel()
        animate().cancel()
    }

    fun dismiss(onFinished: () -> Unit) {
        if (dismissing) return
        dismissing = true
        isClickable = false
        isFocusable = false
        stopAnimations()
        if (!ValueAnimator.areAnimatorsEnabled()) {
            onFinished()
            return
        }
        var done = false
        fun finish() {
            if (done) return
            done = true
            dismissFallback?.let(::removeCallbacks)
            dismissFallback = null
            onFinished()
        }
        dismissFallback = Runnable { finish() }.also { postDelayed(it, 400L) }
        animate()
            .alpha(0f)
            .scaleX(1.03f)
            .scaleY(1.03f)
            .setDuration(240L)
            .setInterpolator(PathInterpolator(0.22f, 1f, 0.36f, 1f))
            .withEndAction { finish() }
            .start()
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        val cx = (right - left) / 2
        val cy = (bottom - top) / 2
        val gw = glowView.measuredWidth
        val gh = glowView.measuredHeight
        glowView.layout(cx - gw / 2, cy - gh / 2, cx + gw / 2, cy + gh / 2)

        val lw = logoView.measuredWidth
        val lh = logoView.measuredHeight
        logoView.layout(cx - lw / 2, cy - lh / 2, cx + lw / 2, cy + lh / 2)

        val fw = footer.measuredWidth
        val fh = footer.measuredHeight
        val footerTop = cy + lh / 2 + dp(16)
        footer.layout(cx - fw / 2, footerTop, cx + fw / 2, footerTop + fh)
    }

    override fun onDetachedFromWindow() {
        stopAnimations()
        super.onDetachedFromWindow()
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density + 0.5f).toInt()

    private class SplashProgressBar(context: Context) : View(context) {
        private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val sweepPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val staticPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val trackRect = RectF()
        private val clipPath = Path()
        private val shaderMatrix = Matrix()
        private var sweepShader: LinearGradient? = null
        private var barWidth = 0f
        private var sweepFraction = 0f
        private var staticMode = false
        private var accentColor = LIGHT_BLUE
        private var accentZero = LIGHT_BLUE_ZERO

        fun applyTheme(dark: Boolean) {
            trackPaint.color = if (dark) DARK_TRACK else LIGHT_TRACK
            accentColor = if (dark) DARK_BLUE else LIGHT_BLUE
            accentZero = if (dark) DARK_BLUE_ZERO else LIGHT_BLUE_ZERO
            staticPaint.color = accentColor
            rebuildShader()
            invalidate()
        }

        fun setSweepFraction(fraction: Float) {
            sweepFraction = fraction
            invalidate()
        }

        fun setStaticMode(static: Boolean) {
            staticMode = static
            invalidate()
        }

        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
            super.onSizeChanged(w, h, oldw, oldh)
            if (w <= 0 || h <= 0) return
            trackRect.set(0f, 0f, w.toFloat(), h.toFloat())
            val radius = h * 0.5f
            clipPath.reset()
            clipPath.addRoundRect(trackRect, radius, radius, Path.Direction.CW)
            barWidth = w * 0.46f
            rebuildShader()
        }

        private fun rebuildShader() {
            if (barWidth <= 0f) {
                sweepShader = null
                return
            }
            sweepShader = LinearGradient(
                0f, 0f, barWidth, 0f,
                intArrayOf(accentZero, accentColor, accentZero),
                floatArrayOf(0f, 0.5f, 1f),
                Shader.TileMode.CLAMP,
            ).also { sweepPaint.shader = it }
        }

        override fun onDraw(canvas: Canvas) {
            if (width <= 0 || height <= 0) return
            val saveCount = canvas.save()
            canvas.clipPath(clipPath)
            canvas.drawRect(trackRect, trackPaint)
            if (staticMode) {
                canvas.drawRect(trackRect, staticPaint)
            } else if (barWidth > 0f) {
                val left = -barWidth + sweepFraction * (width + barWidth)
                shaderMatrix.setTranslate(left, 0f)
                sweepShader?.setLocalMatrix(shaderMatrix)
                canvas.drawRect(left, 0f, left + barWidth, height.toFloat(), sweepPaint)
            }
            canvas.restoreToCount(saveCount)
        }
    }

    private companion object {
        private val LIGHT_BG = Color.WHITE
        private val DARK_BG = Color.rgb(22, 22, 24)
        private val LIGHT_INK = Color.rgb(27, 36, 53)
        private val DARK_INK = Color.rgb(244, 244, 245)
        private val LIGHT_TRACK = Color.rgb(231, 238, 248)
        private val DARK_TRACK = Color.rgb(35, 35, 40)
        private val LIGHT_BLUE = Color.rgb(32, 93, 215)
        private val DARK_BLUE = Color.rgb(163, 184, 255)
        private val LIGHT_BLUE_ZERO = Color.argb(0, 32, 93, 215)
        private val DARK_BLUE_ZERO = Color.argb(0, 163, 184, 255)
    }
}
