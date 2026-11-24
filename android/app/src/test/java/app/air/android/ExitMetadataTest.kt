package app.air.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ExitMetadataTest {
    @Test fun classifiesExitUsageTypesAndRiskLevels() {
        assertEquals("JP", exitCountryCode(" JP "))
        assertNull(exitCountryCode("jp"))
        assertNull(exitCountryCode("ZZZ"))

        assertEquals("datacenter", exitKind("IDC"))
        assertEquals("residential", exitKind("DYN"))
        assertEquals("mobile", exitKind("MOB"))
        assertEquals("gateway", exitKind("GTW"))
        assertNull(exitKind("COM"))
        assertNull(exitKind(null))

        assertEquals("noEvidence", exitQuality("none"))
        assertEquals("lowRisk", exitQuality("low"))
        assertEquals("mediumRisk", exitQuality("medium"))
        assertEquals("highRisk", exitQuality("high"))
        assertNull(exitQuality("unknown"))
        assertNull(exitQuality(""))
    }
}
