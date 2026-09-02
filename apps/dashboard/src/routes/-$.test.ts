import { describe, expect, it } from "vitest"

import { updatesPath } from "./$"

describe("updatesPath", () => {
  it("strips the /api prefix and keeps the query string", () => {
    expect(
      updatesPath(
        new URL(
          "https://ota.example.com/api/admin/branches/staging/groups?limit=50"
        )
      )
    ).toBe("/admin/branches/staging/groups?limit=50")
  })

  it("does not forward pages", () => {
    expect(
      updatesPath(new URL("https://ota.example.com/branches/staging"))
    ).toBeNull()
    expect(updatesPath(new URL("https://ota.example.com/api"))).toBeNull()
  })
})
