# Effect authoring guide

Effects are **data, never components**. A third party defines an effect
as an `EffectDefinition` object, validates it, and hands it to the
catalogue (or directly to the overlay / pipeline). No native code, no
custom view, no fork change — unless the effect needs a renderer
capability that does not exist yet (see the capability matrix below).

## The schema

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Stable slug: `/^[a-z0-9][a-z0-9-]*$/`. Never rename an id after shipping — viewers and hosts match on it. |
| `name` | string | yes | Display name, non-empty. |
| `formatVersion` | number | yes | The schema version this effect was written against. M4: `1`. |
| `version` | number | yes | The effect's own version (positive integer, starts at 1). Bumped when the effect's data changes; independent of `formatVersion`. |
| `tags` | string[] | yes | Discovery tags, each non-empty. Catalogue entries always carry ≥1 tag. |
| `kind` | `"filter" \| "gift"` | yes | Filters are pre-encode; gifts are viewer-overlay. |
| `renderPath` | `"pre-encode" \| "viewer-overlay"` | yes | Must match `kind`: filter → pre-encode, gift → viewer-overlay. |
| `anchors` | `EffectAnchor[]` | yes | May be empty for a grade-only filter (no face needed). |
| `shapes` | `FilterShapeDef[]` | filters only | Shape definitions (see below). |
| `grade` | `FilterGradeParams` | filters only | Full-frame grade. A filter must carry a grade, ≥1 shape, or both — a filter with neither renders nothing and is rejected. |
| `assets` | `EffectAsset[]` | gifts only | Image / lottie / svga / video-alpha assets. A gift with zero assets renders a name pill (M2 behavior); a gift with shapes or a grade is rejected — the overlay never renders them. |
| `animation` | `{ mode, durationMs? }` | yes | `loop` (default behavior for filters), `once`, or `timed` (requires `durationMs > 0`). Any present `durationMs` must be > 0. |
| `trackingLostFallback` | `"banner" \| "stage" \| "hide"` | yes | What viewers see when the face is lost. Filters usually `hide`; gifts pick `banner` or `stage`. |
| `soundUri` | string | no | Carried, not played — the app's gift system owns audio policy. |

### Anchors

```ts
{
  placement: "above-head" | "on-face" | "follow" | "orbit" | "fullscreen",
  landmarkIndices: [10], // MediaPipe 478 indices; empty allowed
  scaleToFace: 1.1, // asset width = scaleToFace × face width; (0, 5]
  offset: { x: 0, y: -0.05 }, // face-width units; x right, y down
}
```

- `landmarkIndices` must be integers in [0, 477]. Empty is legal —
  above-head anchors resolve from face bounds and need no indices.
- Resolution (see `API.md`): above-head → bounds top-center; on-face /
  follow → centroid of the fresh indices, bounds center when none are
  fresh; orbit → bounds center (offset applied at render);
  fullscreen → null.
- The viewer overlay uses only the **first** anchor. Multi-anchor
  effects land later; until then, put the primary anchor first.

### Shapes (filters only)

Shapes are drawn by the native compositors in normalized sensor space,
anchored to the anchor rect:

```ts
{ kind: "ellipse", anchor: 0, color: "#d4af37", fill: true }
{ kind: "rect", anchor: 0, color: "#1a1a1a", fill: false, lineWidth: 0.02 }
{ kind: "line", anchor: 0, color: "#1a1a1a", lineWidth: 0.01, points: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }] }
{ kind: "polyline", anchor: 0, color: "#d4af37", lineWidth: 0.02, points: [...] }
```

- `anchor` is an index into the effect's `anchors` array — a dangling
  index is rejected.
- `color` must be `#rrggbb`. `lineWidth` is a fraction of frame width.
  Rects are fractions of the anchor rect; points are fractions of the
  anchor rect. Lines and polylines require ≥2 points.
- Filters may not list assets: the pre-encode compositor never reads
  them, so the validator rejects the combination rather than silently
  ignoring artwork.

### Grades (filters only)

```ts
{ warmth: 0.3, brightness: 0.04, saturation: 1.18, contrast: 1.06 }
```

All four values are finite numbers; ranges are warmth [-1, 1],
brightness [-1, 1], saturation [0, 3], contrast [0, 3]. The grade
applies with or without a face (grade-only filters need no anchors).
Formula (shared with native): warmth (`R *= 1 + 0.2w`,
`B *= 1 - 0.2w`), saturation (Rec. 601 luminance gray), contrast
around mid-grey, brightness, clamp [0, 1].

### Assets (gifts only)

```ts
{
  kind: "image", // | "lottie" | "svga" | "video-alpha"
  width: 128, height: 128, // positive integers
  uri: "data:image/png;base64,...", // or an http(s) URL
}
```

- `data:` URIs must be `data:image/png|jpeg|gif;base64,…` with
  decodable, non-empty base64; PNG-declared data must start with the
  PNG signature. `http(s)` URIs are syntactically validated only —
  network reachability is the app's runtime concern, not a load check.
  Any other scheme is rejected (React Native `Image` cannot resolve
  it either).
- Animated artwork (lottie / svga / video-alpha) is supported by the
  schema today, but the M2 overlay renders it as a name pill until
  player dependencies land. Do not ship a gift whose only identity is
  an animation the player cannot render yet.

## Validation: fail loud at load

```ts
import { validateEffectDefinition, validateCatalogue } from "react-native-ar-effects";

validateEffectDefinition(myEffect); // throws: Invalid effect "<id>": <problem>
validateCatalogue(effects); // throws on the first bad entry or duplicate id
```

Validation runs at load (catalogue import, `HostFilterPipeline.setEffect`,
`LiveKitFilterAdapter.applyFilter`) — never silently at render. The
error names the effect and the exact problem: bad id, missing
`formatVersion`, unsupported format version, out-of-range landmark
index, kind/renderPath crossing, filter carrying assets, gift carrying
shapes or a grade, a filter that renders nothing, an unresolvable
asset URI, a malformed grade or shape. Every invalid class is covered
by tests in `packages/src/__tests__/effect-validation.test.ts`.

## Worked example: Cat Ears

The catalogue's `cat-ears` filter, annotated:

```ts
{
  id: "cat-ears", // stable slug
  name: "Cat Ears",
  formatVersion: 1, // schema version
  version: 1, // this effect's version
  tags: ["funny", "animal"],
  kind: "filter",
  renderPath: "pre-encode", // viewers see it in the encoded video
  anchors: [
    {
      placement: "above-head",
      landmarkIndices: [10], // forehead — pins the ears to the head
      scaleToFace: 1.25, // ears span 125% of face width
    },
  ],
  shapes: [
    // Outer ears: dark, filled ellipses, left and right of center.
    { kind: "ellipse", anchor: 0, color: "#4a4a4a", fill: true,
      rect: { x: 0.08, y: 0.05, width: 0.3, height: 0.5 } },
    { kind: "ellipse", anchor: 0, color: "#4a4a4a", fill: true,
      rect: { x: 0.62, y: 0.05, width: 0.3, height: 0.5 } },
    // Inner ears: pink, filled, inset inside the outer ears.
    { kind: "ellipse", anchor: 0, color: "#ff9ebb", fill: true,
      rect: { x: 0.17, y: 0.18, width: 0.12, height: 0.28 } },
    { kind: "ellipse", anchor: 0, color: "#ff9ebb", fill: true,
      rect: { x: 0.71, y: 0.18, width: 0.12, height: 0.28 } },
  ],
  animation: { mode: "loop" },
  trackingLostFallback: "hide", // shapes vanish when the face is lost
}
```

Rects are fractions of the anchor rect (here, the above-head region),
so the ears scale with the face and track the head as it moves.

## Adding an effect to the catalogue

1. Write the definition in `packages/src/catalogue.ts` (filters first,
   then gifts — the file order is the catalogue order).
2. Give it a unique slug id, `formatVersion: 1`, `version: 1`, and ≥1 tag.
3. If it needs artwork, add the bytes to `packages/src/catalogue-assets.ts`
   as a data URI (self-contained — no Metro asset resolution, no
   network fetch at render) and reference it from the effect.
4. Run the tests: `packages/src/__tests__/catalogue.test.ts` enforces
   that every entry validates, ids are unique, asset references
   resolve, asset dimensions match their declared width/height, and
   every filter renders commands from a tracked face.
5. Add it to the example picker by nothing — the picker reads
   `CATALOGUE_FILTERS` / `CATALOGUE_GIFTS` directly, so new entries
   appear automatically.

## Renderer capability matrix

| Capability | Pre-encode compositor (iOS CoreImage/CoreGraphics, Android I420/Canvas) | Viewer overlay (React Native + Reanimated) |
| --- | --- | --- |
| Ellipse / rect / line / polyline shapes | ✅ | ❌ (gifts carry assets, not shapes) |
| Full-frame grade | ✅ | ❌ |
| Image assets | ❌ (filters carry no assets) | ✅ (`Image`) |
| Lottie / svga / video-alpha assets | ❌ | Schema only — renders a name pill until player deps land |
| Landmark-anchored placement | ✅ (anchor rects from face state) | ✅ (first anchor only) |
| Animation timing | Loop (shapes are static per frame) | `mode` carried; timing rendered by the app |
| Sound | ❌ | Carried, not played |

If an effect needs something outside this matrix (gradients, masks,
3D models, particle systems), it is a renderer extension — a native
compositor change plus a schema version bump — not an authoring
exercise. Propose it as a milestone, not a catalogue entry.

## Versioning policy

- `formatVersion` is the **schema** version. It changes only when the
  `EffectDefinition` shape itself changes (a field added, removed, or
  reinterpreted). Consumers validate against the version they know:
  an unknown `formatVersion` fails loud at load, never silently
  misrenders.
- `version` is the **effect** version. It changes when one effect's
  data changes (new colors, new anchors, new artwork). Hosts and
  viewers match effects by `id`; a version bump tells an app the
  effect's look changed and its cached copy is stale.
- M4 rule: every catalogue entry is `formatVersion: 1`, `version: 1`.
  When the schema next changes, old effects keep their written
  `formatVersion` and the validator decides compatibility explicitly —
  no silent coercion.
