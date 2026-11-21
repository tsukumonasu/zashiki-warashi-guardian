/**
 * Tests for the Rekognition adapter (cloud-judgement task 16.2).
 *
 * Request and response shapes were checked against the AWS documentation:
 * - https://docs.aws.amazon.com/rekognition/latest/APIReference/API_SearchFacesByImage.html
 *   (request: CollectionId, FaceMatchThreshold 0..100, QualityFilter NONE|AUTO|LOW|MEDIUM|HIGH,
 *   MaxFaces; response: FaceMatches[].Similarity, SearchedFaceBoundingBox,
 *   SearchedFaceConfidence; "no face" is reported as InvalidParameterException; errors include
 *   ThrottlingException and ProvisionedThroughputExceededException)
 * - https://docs.aws.amazon.com/rekognition/latest/APIReference/API_DetectFaces.html
 *   (request: Attributes, Image; response: FaceDetails[].BoundingBox / Quality.Brightness /
 *   Quality.Sharpness / Pose.Yaw)
 * Note: the docs do not list LimitExceededException for these two operations; the adapter treats
 * it as throttling anyway, which is harmless.
 */

import { RekognitionClient, DetectFacesCommand, SearchFacesByImageCommand } from "@aws-sdk/client-rekognition";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import {
  RekognitionThrottledError,
  createRekognitionFaceSearch,
} from "../lambda/_shared/adapters/rekognition.js";

const rek = mockClient(RekognitionClient);
const image = new Uint8Array([1, 2, 3]);
const awsError = (name: string) => Object.assign(new Error(name), { name });
const box = { Left: 0.1, Top: 0.2, Width: 0.3, Height: 0.4 };

function adapter() {
  return createRekognitionFaceSearch(new RekognitionClient({ region: "ap-northeast-1" }));
}

beforeEach(() => {
  rek.reset();
});

describe("search", () => {
  it("sends the documented request shape", async () => {
    rek.on(SearchFacesByImageCommand).resolves({ SearchedFaceBoundingBox: box });
    await adapter().search(image, "household", 70);
    const input = rek.commandCalls(SearchFacesByImageCommand)[0]?.args[0].input;
    expect(input).toEqual({
      CollectionId: "household",
      Image: { Bytes: image },
      FaceMatchThreshold: 70,
      QualityFilter: "NONE",
      MaxFaces: 1,
    });
  });

  it("returns the box, face confidence and best similarity", async () => {
    rek.on(SearchFacesByImageCommand).resolves({
      SearchedFaceBoundingBox: box,
      SearchedFaceConfidence: 99.5,
      FaceMatches: [{ Similarity: 91.2 }, { Similarity: 80 }],
    });
    expect(await adapter().search(image, "c", 70)).toEqual({
      kind: "face",
      box: { left: 0.1, top: 0.2, width: 0.3, height: 0.4 },
      faceConfidence: 99.5,
      bestSimilarity: 91.2,
    });
  });

  it("reports a null similarity when nothing matched", async () => {
    rek.on(SearchFacesByImageCommand).resolves({
      SearchedFaceBoundingBox: box,
      SearchedFaceConfidence: 97,
      FaceMatches: [],
    });
    const out = await adapter().search(image, "c", 70);
    expect(out).toMatchObject({ kind: "face", bestSimilarity: null });
  });

  it("returns no_face when the response has no bounding box", async () => {
    rek.on(SearchFacesByImageCommand).resolves({});
    expect(await adapter().search(image, "c", 70)).toEqual({ kind: "no_face" });
  });

  it("maps InvalidParameterException to no_face when DetectFaces finds no face", async () => {
    rek.on(SearchFacesByImageCommand).rejects(awsError("InvalidParameterException"));
    rek.on(DetectFacesCommand).resolves({ FaceDetails: [] });
    expect(await adapter().search(image, "c", 70)).toEqual({ kind: "no_face" });
  });

  it("rethrows InvalidParameterException when DetectFaces does find a face", async () => {
    rek.on(SearchFacesByImageCommand).rejects(awsError("InvalidParameterException"));
    rek.on(DetectFacesCommand).resolves({ FaceDetails: [{ BoundingBox: box }] });
    await expect(adapter().search(image, "c", 70)).rejects.toMatchObject({
      name: "InvalidParameterException",
    });
  });

  it.each(["ThrottlingException", "ProvisionedThroughputExceededException"])(
    "maps %s to RekognitionThrottledError without calling DetectFaces",
    async (name) => {
      rek.on(SearchFacesByImageCommand).rejects(awsError(name));
      await expect(adapter().search(image, "c", 70)).rejects.toBeInstanceOf(
        RekognitionThrottledError,
      );
      expect(rek.commandCalls(DetectFacesCommand)).toHaveLength(0);
    },
  );

  it("rethrows other errors unchanged", async () => {
    rek.on(SearchFacesByImageCommand).rejects(awsError("ResourceNotFoundException"));
    await expect(adapter().search(image, "c", 70)).rejects.toMatchObject({
      name: "ResourceNotFoundException",
    });
  });
});

describe("detect", () => {
  it("requests all attributes for the image bytes", async () => {
    rek.on(DetectFacesCommand).resolves({ FaceDetails: [] });
    await adapter().detect(image);
    expect(rek.commandCalls(DetectFacesCommand)[0]?.args[0].input).toEqual({
      Image: { Bytes: image },
      Attributes: ["ALL"],
    });
  });

  it("returns zero faces and no quality for an empty response", async () => {
    rek.on(DetectFacesCommand).resolves({});
    expect(await adapter().detect(image)).toEqual({ faces: 0, quality: null, box: null });
  });

  it("extracts the box and quality of the largest face", async () => {
    rek.on(DetectFacesCommand).resolves({
      FaceDetails: [
        {
          BoundingBox: { Left: 0, Top: 0, Width: 0.1, Height: 0.1 },
          Quality: { Sharpness: 1, Brightness: 2 },
          Pose: { Yaw: 3 },
        },
        {
          BoundingBox: box,
          Quality: { Sharpness: 80, Brightness: 60 },
          Pose: { Yaw: -12.5 },
        },
      ],
    });
    expect(await adapter().detect(image)).toEqual({
      faces: 2,
      box: { left: 0.1, top: 0.2, width: 0.3, height: 0.4 },
      quality: { sharpness: 80, brightness: 60, yawDeg: -12.5 },
    });
  });

  it("returns null quality when a quality field is missing", async () => {
    rek.on(DetectFacesCommand).resolves({
      FaceDetails: [{ BoundingBox: box, Quality: { Sharpness: 80 }, Pose: { Yaw: 0 } }],
    });
    const out = await adapter().detect(image);
    expect(out.quality).toBeNull();
    expect(out.box).not.toBeNull();
  });

  it("maps throttling to RekognitionThrottledError", async () => {
    rek.on(DetectFacesCommand).rejects(awsError("ThrottlingException"));
    await expect(adapter().detect(image)).rejects.toBeInstanceOf(RekognitionThrottledError);
  });
});
