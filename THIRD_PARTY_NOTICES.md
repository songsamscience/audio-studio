# 외부 소프트웨어 고지

이 사이트는 아래 외부 소프트웨어를 `vendor/` 폴더에 그대로 담아, 방문자의 브라우저로 내려보내 실행합니다. 각 라이선스 전문은 `licenses/` 폴더와 `vendor/PRETENDARD-LICENSE.txt`에 있습니다.

## @ffmpeg/core 0.12.10 (FFmpeg 5.1.4 기반 단일 스레드 WebAssembly)

- 파일: `vendor/ffmpeg-core.js`, `vendor/ffmpeg-core.wasm` (32,232,419바이트, SHA-256 `9F57947A5BD530D8F00C5B3F2CB2A3492FAA7E5D823315342D6A8656D0A6B7B7`). 내려받은 곳: npm `@ffmpeg/core@0.12.10`의 `dist/umd/`. 고치지 않은 원본입니다.
- 라이선스: **GPL-2.0-or-later** (`--enable-gpl`, libx264·libx265 포함). 전문: `licenses/COPYING.GPLv2`, `licenses/COPYING.GPLv3`, `licenses/COPYING.LGPLv2.1`, `licenses/FFmpeg-LICENSE.md`. 함께 빌드된 라이브러리의 라이선스도 `licenses/`에 있습니다.
- **대응 소스(Corresponding Source)** — 이 바이너리를 만든 정확한 소스입니다.
  - ffmpeg.wasm 빌드 스크립트·바인딩: https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v12.15 (릴리스 「v12.10 (core, core-mt)」, 2025-01-07). 빌드 방법은 그 태그의 `Dockerfile`이며 사본이 `licenses/ffmpeg-wasm-Dockerfile`에 있습니다.
  - FFmpeg: https://github.com/FFmpeg/FFmpeg/tree/n5.1.4
  - 함께 빌드된 라이브러리와 버전(위 Dockerfile 기준): x264 `4-cores` 브랜치, x265 3.4, libvpx v1.13.1, LAME `master`, libogg v1.3.4, libtheora v1.1.1, libopus v1.3.1, libvorbis v1.3.3, zlib v1.2.11, libwebp v1.3.2, FreeType VER-2-10-4, FriBidi v1.0.9, HarfBuzz 5.2.0, libass 0.15.0, zimg release-3.0.5. 각 소스 주소는 `licenses/license-sources.json`과 Dockerfile에 있습니다.
- 위 주소의 소스를 받을 수 없게 되면 이 저장소의 이슈로 요청해 주세요. 같은 소스를 제공하겠습니다.

## Pretendard Variable 1.3.9

- 파일: `vendor/PretendardVariable.woff2`. Copyright (c) 2021, Kil Hyung-jin. SIL Open Font License 1.1. 전문: `vendor/PRETENDARD-LICENSE.txt`. 원본: https://github.com/orioncactus/pretendard/tree/v1.3.9

---

실행 자원은 모두 이 사이트의 `vendor/` 폴더에서 읽습니다. 위 링크는 출처 설명용이며, 사이트는 실행 중에 외부 서비스를 호출하지 않습니다. 사용자가 여는 음원·영상의 저작권은 해당 권리자에게 있습니다.
