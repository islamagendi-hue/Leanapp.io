package io.leanapp.analytics

import org.junit.Assert.assertEquals
import org.junit.Test

class JsonTest {
    @Test fun roundTripsNestedValuesAndArabicText() {
        val v = linkedMapOf<String, Any?>(
            "name" to "طلب \"جديد\"\n",
            "n" to 45L, "d" to 1.5, "b" to true, "z" to null,
            "list" to listOf(1L, "x", mapOf("k" to false)),
        )
        assertEquals(v, Json.parse(Json.encode(v)))
    }

    @Test fun encodesWholeDoublesWithoutFraction() {
        assertEquals("""{"revenue":45,"nan":null}""", Json.encode(linkedMapOf("revenue" to 45.0, "nan" to Double.NaN)))
    }

    @Test fun formatsTimestampsLikeJavaScript() {
        assertEquals("2026-10-05T10:00:00.000Z", Iso8601.format(1_791_194_400_000L))
    }
}
