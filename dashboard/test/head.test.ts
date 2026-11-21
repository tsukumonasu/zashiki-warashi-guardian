import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/simulation/config";
import { headTarget } from "../src/simulation/head";

// Golden table: the same cases as the device's head tracker (hfov 54, vfov 41.8, limits 30/20).
// Faces are 0.1 x 0.1 boxes unless noted; the centre is left + 0.05, top + 0.05.
const cases: Array<{
  name: string;
  face: { left: number; top: number; width: number; height: number };
  snap: [number, number];
  expected: [number, number];
}> = [
  { name: "centre face", face: { left: 0.45, top: 0.45, width: 0.1, height: 0.1 }, snap: [0, 0], expected: [0, 0] },
  { name: "centre face keeps snapshot angles", face: { left: 0.45, top: 0.45, width: 0.1, height: 0.1 }, snap: [10, -5], expected: [10, -5] },
  { name: "right edge (cx 0.75)", face: { left: 0.7, top: 0.45, width: 0.1, height: 0.1 }, snap: [0, 0], expected: [13.5, 0] },
  { name: "left edge (cx 0.25)", face: { left: 0.2, top: 0.45, width: 0.1, height: 0.1 }, snap: [0, 0], expected: [-13.5, 0] },
  { name: "above centre (cy 0.25)", face: { left: 0.45, top: 0.2, width: 0.1, height: 0.1 }, snap: [0, 0], expected: [0, 10.45] },
  { name: "below centre (cy 0.75)", face: { left: 0.45, top: 0.7, width: 0.1, height: 0.1 }, snap: [0, 0], expected: [0, -10.45] },
  { name: "top-left corner clamps tilt", face: { left: 0, top: 0, width: 0, height: 0 }, snap: [0, 0], expected: [-27, 20] },
  { name: "bottom-right corner clamps tilt", face: { left: 1, top: 1, width: 0, height: 0 }, snap: [0, 0], expected: [27, -20] },
  { name: "pan clamps at the limit", face: { left: 0.95, top: 0.45, width: 0.05, height: 0.1 }, snap: [25, 0], expected: [30, 0] },
  { name: "box past the edge caps centre at 1", face: { left: 0.9, top: 0.45, width: 0.5, height: 0.1 }, snap: [0, 0], expected: [27, 0] },
  { name: "out-of-range box fields are clamped", face: { left: -5, top: 9, width: 0, height: 0 }, snap: [0, 0], expected: [-27, -20] },
];

describe("headTarget golden table", () => {
  for (const c of cases) {
    it(c.name, () => {
      const [pan, tilt] = headTarget(c.face, c.snap[0], c.snap[1], DEFAULT_CONFIG);
      expect(pan).toBeCloseTo(c.expected[0], 6);
      expect(tilt).toBeCloseTo(c.expected[1], 6);
    });
  }

  it("rejects non-finite input like the device", () => {
    expect(() =>
      headTarget({ left: NaN, top: 0, width: 0, height: 0 }, 0, 0, DEFAULT_CONFIG),
    ).toThrow();
  });
});
