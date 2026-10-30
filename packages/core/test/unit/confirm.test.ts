// CONF-1 to CONF-8: structured confirmation, without a database.
//
// The payload, the code, the hash and the four rules of CONF-4 are the
// whole safety story of an irreversible call, and none of them needs
// Postgres to be proven. What needs a real database is the claim in
// CONF-5, and that is in the integration suite.
//
// Several of these exist only to prove a mistake would be caught. A
// signature that is not checked, a hash that is not compared, a confirm
// from the wrong person: each of those would look like a working feature
// right up to the day it mattered.
import { test, expect, describe } from "bun:test"
import {
  buttonPayload,
  parsePayload,
  payloadIsValid,
  argsHash,
  newCode,
  shortId,
  longId,
  MAX_PAYLOAD_BYTES,
  PAYLOAD_PREFIX,
  CANCEL_WORD,
} from "../../src/runtime/confirm.ts"

const SECRET = "a-long-random-string-from-the-environment"
const ACTION = "11111111-2222-3333-4444-555555555555"
const PERSON = "99999999-8888-7777-6666-555555555555"

describe("CONF-3: the button payloads", () => {
  test("CONF-3: the payload is ob1, the verb, the action and a signature", () => {
    const payload = buttonPayload("c", ACTION, PERSON, SECRET)
    const parts = payload.split(".")

    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe(PAYLOAD_PREFIX)
    expect(parts[1]).toBe("c")
    // The action id in short form, which is what a 64 byte button can
    // carry. Read back, it is the id again.
    expect(parts[2]).toBe(shortId(ACTION))
    expect(parsePayload(payload)?.actionId).toBe(ACTION)
    expect(parts[3]).toMatch(/^[0-9a-f]{32}$/)
  })

  // T10.4 found this against Telegram's own docs: an inline button carries
  // 1 to 64 bytes of hidden data, and the payload was 75. Everything else
  // we ship glue for is roomier (Discord allows 100), so the tightest
  // channel is the one the format has to fit.
  test("CONF-3: a payload fits the tightest button we ship glue for", () => {
    const payload = buttonPayload("c", ACTION, PERSON, SECRET)

    expect(MAX_PAYLOAD_BYTES).toBe(64)
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    // Both verbs, since Cancel is the one nobody checks.
    expect(
      Buffer.byteLength(buttonPayload("x", ACTION, PERSON, SECRET), "utf8"),
    ).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
  })

  test("CONF-3: the short form is the same 16 bytes, written shorter", () => {
    expect(shortId(ACTION)).toHaveLength(22)
    expect(longId(shortId(ACTION))).toBe(ACTION)
    // Anything that is not an id is left exactly as it is, so a payload
    // built from something odd still parses the way it used to.
    expect(shortId("")).toBe("")
    expect(shortId("42")).toBe("42")
    expect(longId("not-a-short-id")).toBe("not-a-short-id")
  })

  test("CONF-3: a payload carrying the id in full is still read", () => {
    // So a button somebody was sent before an upgrade still works. The
    // signature is over the id either way, so this is a spelling of the
    // same authorisation and not a second way in.
    const long = [
      PAYLOAD_PREFIX,
      "c",
      ACTION,
      buttonPayload("c", ACTION, PERSON, SECRET).split(".")[3],
    ].join(".")
    const parsed = parsePayload(long)

    expect(parsed?.actionId).toBe(ACTION)
    expect(payloadIsValid(parsed!, PERSON, SECRET)).toBe(true)
  })

  test("CONF-3: Confirm and Cancel are different payloads", () => {
    // The verb is signed, so a Cancel cannot be edited into a Confirm.
    const confirm = buttonPayload("c", ACTION, PERSON, SECRET)
    const cancel = buttonPayload("x", ACTION, PERSON, SECRET)

    expect(confirm).not.toBe(cancel)
    const swapped = cancel.replace(".x.", ".c.")
    expect(payloadIsValid(parsePayload(swapped)!, PERSON, SECRET)).toBe(false)
  })

  test("CONF-3: a payload signed for one person is not valid for another", () => {
    // The person is in the signature, which is what stops a payload
    // forwarded to a group chat being tapped by somebody else.
    const payload = buttonPayload("c", ACTION, PERSON, SECRET)
    const parsed = parsePayload(payload)

    expect(payloadIsValid(parsed!, PERSON, SECRET)).toBe(true)
    expect(payloadIsValid(parsed!, "someone-else", SECRET)).toBe(false)
  })

  test("CONF-3: the action id cannot be changed without breaking the signature", () => {
    const payload = buttonPayload("c", ACTION, PERSON, SECRET)
    const other = "00000000-0000-0000-0000-000000000000"
    // The payload carries the id in short form, so that is what an
    // attacker would be editing.
    const forged = payload.replace(shortId(ACTION), shortId(other))

    expect(forged).not.toBe(payload)
    expect(parsePayload(forged)?.actionId).toBe(other)
    expect(payloadIsValid(parsePayload(forged)!, PERSON, SECRET)).toBe(false)
  })

  test("CONF-3: a different secret does not verify", () => {
    const payload = buttonPayload("c", ACTION, PERSON, SECRET)

    expect(payloadIsValid(parsePayload(payload)!, PERSON, "a-different-secret")).toBe(false)
  })

  test("CONF-3: anything that is not a payload is not read as one", () => {
    for (const text of [
      "",
      "hello",
      "4821",
      "ob1",
      "ob1.c",
      "ob1.c.abc",
      "ob2.c.abc.def",
      "ob1.z.abc.def",
      "ob1.c..def",
      "ob1.c.abc.",
      "ob1.c.abc.def.ghi",
    ]) {
      expect(parsePayload(text)).toBeNull()
    }
  })

  test("CONF-3: a signature of the wrong length is refused, not compared", () => {
    // timingSafeEqual throws on a length mismatch, so this has to be
    // checked first. A test, because a crash here would be a crash on
    // anything a stranger can send.
    const parsed = parsePayload("ob1.c.abc.00")
    expect(parsed).not.toBeNull()
    expect(payloadIsValid(parsed!, PERSON, SECRET)).toBe(false)
  })
})

describe("CONF-4: the arguments hash", () => {
  test("CONF-4: the same arguments hash the same, whatever order they are written in", () => {
    // Otherwise a confirmation would be rejected because a key moved,
    // which is a confusing way to lose a booking.
    expect(argsHash({ size: 4, date: "2026-10-23" })).toBe(
      argsHash({ date: "2026-10-23", size: 4 }),
    )
  })

  test("CONF-4: changing any argument changes the hash", () => {
    const original = argsHash({ size: 4, date: "2026-10-23" })

    expect(argsHash({ size: 6, date: "2026-10-23" })).not.toBe(original)
    expect(argsHash({ size: 4, date: "2026-10-24" })).not.toBe(original)
    expect(argsHash({ size: 4 })).not.toBe(original)
    expect(argsHash({ size: 4, date: "2026-10-23", note: "" })).not.toBe(original)
  })

  test("CONF-4: a nested change changes the hash too", () => {
    expect(argsHash({ guest: { name: "Asha" } })).not.toBe(argsHash({ guest: { name: "Ravi" } }))
  })

  test("CONF-4: 4 is not the same as the text 4", () => {
    expect(argsHash({ size: 4 })).not.toBe(argsHash({ size: "4" }))
  })
})

describe("CONF-1: the code", () => {
  test("CONF-1: it is four digits, always", () => {
    for (let i = 0; i < 500; i++) {
      expect(newCode()).toMatch(/^\d{4}$/)
    }
  })

  test("CONF-1: a leading zero is kept, so it is always four characters", () => {
    // `String(7)` would be "7", and "Reply 7 to confirm" is a different
    // thing to type. 500 draws is enough to see a low number.
    const codes = Array.from({ length: 500 }, () => newCode())
    expect(codes.every((code) => code.length === 4)).toBe(true)
  })

  test("CONF-1: the codes are not all the same", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newCode()))
    expect(codes.size).toBeGreaterThan(100)
  })
})

describe("CONF-8: the cancel word", () => {
  test("CONF-8: it is the plain word, so a channel with no buttons still has a way out", () => {
    expect(CANCEL_WORD).toBe("cancel")
  })
})
