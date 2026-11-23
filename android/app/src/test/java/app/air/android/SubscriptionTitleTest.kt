package app.air.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SubscriptionTitleTest {
    @Test fun usesFilenameWhenTheProviderOmitsProfileTitle() {
        assertEquals("SakuraCat", subscriptionTitle(null, "attachment; filename=\"SakuraCat\"; filename*=UTF-8''SakuraCat"))
        assertEquals("日本 + 香港", subscriptionTitle(null,
            "attachment; filename=\"Fallback.yaml\"; filename*=UTF-8'ja'%E6%97%A5%E6%9C%AC%20+%20%E9%A6%99%E6%B8%AF.YML"))
        assertEquals("Team; A", subscriptionTitle(null, "attachment; filename=\"Team; A.yaml\""))
        assertEquals("東京", subscriptionTitle(null, "INLINE; filename=\"Tokyo.yaml\"; filename*=UTF-8''%E6%9D%B1%E4%BA%AC.yml"))
        assertEquals("SakuraCat", subscriptionTitle(null, "inline; filename=\"SakuraCat.yaml\""))
    }

    @Test fun prefersValidProfileTitlesAndIgnoresUnusableFilenames() {
        val disposition = "attachment; filename=\"SakuraCat.yaml\"; filename*=UTF-8''%ZZ"
        assertEquals("Family", subscriptionTitle("base64:RmFtaWx5", disposition))
        assertEquals("SakuraCat", subscriptionTitle("base64:!!!!", disposition))
        assertNull(subscriptionTitle(null, "attachment; filename=\".yaml\""))
        assertNull(subscriptionTitle(null, null))
    }
}
