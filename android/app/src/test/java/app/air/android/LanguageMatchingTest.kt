package app.air.android

import org.junit.Assert.assertEquals
import org.junit.Test

class LanguageMatchingTest {
    @Test fun matchesInstalledPacksAndFallsBackToEnglish() {
        val base = setOf("zh-CN", "en", "fr", "es-MX")
        assertEquals("zh-CN", Languages.matchLanguage("zh-Hant-TW", base))
        assertEquals("en", Languages.matchLanguage("nl-NL", base))
        assertEquals("en", Languages.matchLanguage("en-US", base))
        assertEquals("fr", Languages.matchLanguage("fr-CA", base))
        assertEquals("es-MX", Languages.matchLanguage("es-AR", base))
        assertEquals("en", Languages.matchLanguage("es-AR", base + "es-ES"))
        assertEquals("es-ES", Languages.matchLanguage("es-es", base + "es-ES"))
    }
}
