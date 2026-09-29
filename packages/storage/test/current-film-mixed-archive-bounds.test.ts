import {expect,test} from "bun:test";
import {mixedArchiveFileSize} from "../../../scripts/verify-current-film-mixed-archive";

test("archive size allowance is only the exact measured mixed final MP4",()=>{
  const video={path:"project/film/output/film.mp4",bytes:10*1024**3,sha256:"a".repeat(64)};
  expect(mixedArchiveFileSize(video.path,video.bytes,video)).toBe(true);
  expect(mixedArchiveFileSize(video.path,video.bytes-1,video)).toBe(false);
  expect(mixedArchiveFileSize("project/film/clips/native.wav",video.bytes,video)).toBe(false);
  expect(mixedArchiveFileSize("project/other/output/film.mp4",video.bytes,video)).toBe(false);
  expect(mixedArchiveFileSize(video.path,video.bytes)).toBe(false);
  expect(mixedArchiveFileSize(video.path,video.bytes,{...video,sha256:"invalid"})).toBe(false);
  expect(mixedArchiveFileSize(video.path,129*1024**3,{...video,bytes:129*1024**3})).toBe(false);
  expect(mixedArchiveFileSize("project/film/clips/shot.mp4",8*1024**3)).toBe(true);
  expect(mixedArchiveFileSize(video.path,Number.NaN,video)).toBe(false);
});
