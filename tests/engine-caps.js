/* Development aid: lists what the pinned ffmpeg-core really supports and tries each candidate output.
 * Open http://127.0.0.1:8765/tests/engine-caps.html (serve.py). Nothing leaves the browser. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const worker = new Worker('engine-caps-worker.js');
  const trials1 = [
    ['opus 48k stereo 96k', 'o.opus', ['-i', 'tone.wav', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', 'o.opus']],
    ['opus 22k mono (resample)', 'o2.opus', ['-i', 'tone22.wav', '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-ac', '1', 'o2.opus']],
    ['opus in ogg muxer', 'o3.ogg', ['-i', 'tone.wav', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-f', 'ogg', 'o3.ogg']],
    ['opus in webm', 'o4.webm', ['-i', 'tone.wav', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', 'o4.webm']],
    ['vorbis in webm', 'o5.webm', ['-i', 'tone.wav', '-c:a', 'libvorbis', '-q:a', '4', 'o5.webm']],
    ['aac adts (.aac)', 'o.aac', ['-i', 'tone.wav', '-c:a', 'aac', '-b:a', '160k', 'o.aac']],
    ['aac in mp4 (.mp4 audio only)', 'o.mp4', ['-i', 'tone.wav', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'o.mp4']],
    ['alac in m4a', 'oa.m4a', ['-i', 'tone.wav', '-c:a', 'alac', 'oa.m4a']],
    ['aiff pcm_s16be', 'o.aiff', ['-i', 'tone.wav', '-c:a', 'pcm_s16be', 'o.aiff']],
    ['aiff pcm_s24be', 'o24.aiff', ['-i', 'tone.wav', '-c:a', 'pcm_s24be', 'o24.aiff']],
    ['caf pcm_s16le', 'o.caf', ['-i', 'tone.wav', '-c:a', 'pcm_s16le', 'o.caf']],
    ['au pcm_s16be', 'o.au', ['-i', 'tone.wav', '-c:a', 'pcm_s16be', 'o.au']],
    ['wav pcm_u8', 'o8.wav', ['-i', 'tone.wav', '-c:a', 'pcm_u8', 'o8.wav']],
    ['wav pcm_f32le', 'of.wav', ['-i', 'tone.wav', '-c:a', 'pcm_f32le', 'of.wav']],
    ['wav adpcm_ima_wav', 'oi.wav', ['-i', 'tone.wav', '-c:a', 'adpcm_ima_wav', 'oi.wav']],
    ['mp2', 'o.mp2', ['-i', 'tone.wav', '-c:a', 'mp2', '-b:a', '192k', 'o.mp2']],
    ['ac3', 'o.ac3', ['-i', 'tone.wav', '-c:a', 'ac3', '-b:a', '192k', 'o.ac3']],
    ['wma v2 (.wma)', 'o.wma', ['-i', 'tone.wav', '-c:a', 'wmav2', '-b:a', '128k', 'o.wma']],
    ['amr-nb', 'o.amr', ['-i', 'tone.wav', '-c:a', 'libopencore_amrnb', '-ar', '8000', '-ac', '1', '-b:a', '12.2k', 'o.amr']],
    ['gsm', 'o.gsm', ['-i', 'tone.wav', '-c:a', 'libgsm', '-ar', '8000', '-ac', '1', 'o.gsm']],
    ['mp4 video: png loop + aac, 640x360 1fps x264 ultrafast', 'v1.mp4', ['-loop', '1', '-framerate', '1', '-i', 'cover.png', '-i', 'tone.wav', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '1', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', 'v1.mp4']],
    ['mp4 video: color source 1280x720 2fps x264', 'v2.mp4', ['-f', 'lavfi', '-i', 'color=c=0x49301f:s=1280x720:r=2', '-i', 'tone.wav', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', 'v2.mp4']],
    ['mp4 video: showwaves 640x360 10fps', 'v3.mp4', ['-i', 'tone.wav', '-filter_complex', '[0:a]showwaves=s=640x360:mode=cline:rate=10:colors=0xefb379[v]', '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest', 'v3.mp4']],
    ['mp4 video: drawtext (font needed)', 'v4.mp4', ['-f', 'lavfi', '-i', 'color=c=0x49301f:s=640x360:r=1', '-i', 'tone.wav', '-vf', "drawtext=text='Test':fontcolor=white:fontsize=40:x=20:y=20", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'v4.mp4']],
    ['webm video: vp8 color 2fps + opus', 'v5.webm', ['-f', 'lavfi', '-i', 'color=c=0x49301f:s=640x360:r=2', '-i', 'tone.wav', '-c:v', 'libvpx', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-b:a', '96k', '-shortest', 'v5.webm']],
    ['filters: pan swap / areverse', 'f1.wav', ['-i', 'tone.wav', '-af', 'pan=stereo|c0=c1|c1=c0,areverse', 'f1.wav']],
    ['filters: dynaudnorm + silenceremove', 'f2.wav', ['-i', 'tone.wav', '-af', 'silenceremove=start_periods=1:start_threshold=-50dB,dynaudnorm', 'f2.wav']],
  ];
  const trials2 = [
    ['opus mono from 48k stereo input', 'p1.opus', ['-i', 'tone.wav', '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-ac', '1', 'p1.opus']],
    ['opus stereo from 22k mono input', 'p2.opus', ['-i', 'tone22.wav', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', 'p2.opus']],
    ['opus stereo 48k input + explicit aresample', 'p3.opus', ['-i', 'tone.wav', '-af', 'aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo', '-c:a', 'libopus', '-b:a', '96k', 'p3.opus']],
    ['opus stereo vbr off', 'p4.opus', ['-i', 'tone.wav', '-c:a', 'libopus', '-b:a', '96k', '-vbr', 'off', 'p4.opus']],
    ['opus stereo application voip frame 20', 'p5.opus', ['-i', 'tone.wav', '-c:a', 'libopus', '-b:a', '96k', '-application', 'voip', '-frame_duration', '20', 'p5.opus']],
    ['opus stereo compression_level 0', 'p6.opus', ['-i', 'tone.wav', '-c:a', 'libopus', '-b:a', '96k', '-compression_level', '0', 'p6.opus']],
    ['opus stereo via float input', 'p7.opus', ['-i', 'tone.wav', '-c:a', 'pcm_f32le', 'tmpf.wav'], 'then'],
    ['opus stereo from 44.1k input', 'p8.opus', ['-i', 'tone.wav', '-ar', '44100', '-c:a', 'pcm_s16le', 'tmp44.wav'], 'then'],
    ['opus stereo 32k input', 'p9.opus', ['-i', 'tone.wav', '-ar', '32000', '-c:a', 'pcm_s16le', 'tmp32.wav'], 'then'],
    ['native opus encoder (experimental) stereo', 'p10.opus', ['-i', 'tone.wav', '-c:a', 'opus', '-strict', '-2', '-b:a', '96k', 'p10.opus']],
    ['webm video: vp8 color 2fps + vorbis', 'w1.webm', ['-f', 'lavfi', '-i', 'color=c=0x49301f:s=640x360:r=2', '-i', 'tone.wav', '-c:v', 'libvpx', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libvorbis', '-q:a', '4', '-shortest', 'w1.webm']],
    ['aac coder fast 8s', 'a1.m4a', ['-i', 'tone.wav', '-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '160k', 'a1.m4a']],
    ['aac coder twoloop 8s', 'a2.m4a', ['-i', 'tone.wav', '-c:a', 'aac', '-b:a', '160k', 'a2.m4a']],
    ['mp4 png loop 1280x720 1fps exact -t 8', 'x1.mp4', ['-loop', '1', '-framerate', '1', '-i', 'cover.png', '-i', 'tone.wav', '-vf', 'scale=1280:720', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '1', '-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '160k', '-movflags', '+faststart', 'x1.mp4']],
    ['mp4 png loop 1280x720 1fps veryfast crf 23', 'x2.mp4', ['-loop', '1', '-framerate', '1', '-i', 'cover.png', '-i', 'tone.wav', '-vf', 'scale=1280:720', '-t', '8', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '1', '-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '160k', '-movflags', '+faststart', 'x2.mp4']],
    ['mp4 showwaves 854x480 8fps -t 8', 'x3.mp4', ['-i', 'tone.wav', '-filter_complex', '[0:a]showwaves=s=854x480:mode=cline:rate=8:colors=0xefb379,format=yuv420p[v]', '-map', '[v]', '-map', '0:a', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '160k', 'x3.mp4']],
    ['mp4 showspectrum-like showfreqs? skip; overlay waves on color 854x480 8fps', 'x4.mp4', ['-f', 'lavfi', '-i', 'color=c=0x49301f:s=854x480:r=8', '-i', 'tone.wav', '-filter_complex', '[1:a]showwaves=s=854x200:mode=cline:rate=8:colors=0xefb379[w];[0:v][w]overlay=0:140:shortest=1,format=yuv420p[v]', '-map', '[v]', '-map', '1:a', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '160k', 'x4.mp4']],
    ['filters: pan left only to stereo', 'f3.wav', ['-i', 'tone.wav', '-af', 'pan=stereo|c0=c0|c1=c0', 'f3.wav']],
    ['mp3 from 8-bit input ok? (pcm_u8 wav decode)', 'f4.mp3', ['-i', 'tone.wav', '-c:a', 'pcm_u8', 'tmp8.wav'], 'then'],
  ];
  const chained = { 'p7.opus': ['-i', 'tmpf.wav', '-c:a', 'libopus', '-b:a', '96k', 'p7.opus'], 'p8.opus': ['-i', 'tmp44.wav', '-c:a', 'libopus', '-b:a', '96k', 'p8.opus'], 'p9.opus': ['-i', 'tmp32.wav', '-c:a', 'libopus', '-b:a', '96k', 'p9.opus'], 'f4.mp3': ['-i', 'tmp8.wav', '-c:a', 'libmp3lame', '-b:a', '128k', 'f4.mp3'] };
  const trials3 = [
    ['opus stereo level 3 (60s)', 'q3.opus', ['-i', 'tone.wav', '-c:a', 'libopus', '-b:a', '96k', '-compression_level', '3', 'q3.opus']],
    ['opus stereo level 5 (60s)', 'q5.opus', ['-i', 'tone.wav', '-c:a', 'libopus', '-b:a', '96k', '-compression_level', '5', 'q5.opus']],
    ['opus stereo level 7 (60s)', 'q7.opus', ['-i', 'tone.wav', '-c:a', 'libopus', '-b:a', '96k', '-compression_level', '7', 'q7.opus']],
    ['opus stereo level 9 (60s)', 'q9.opus', ['-i', 'tone.wav', '-c:a', 'libopus', '-b:a', '96k', '-compression_level', '9', 'q9.opus']],
    ['opus mono level 10 (60s)', 'q10m.opus', ['-i', 'tone.wav', '-c:a', 'libopus', '-b:a', '64k', '-ac', '1', 'q10m.opus']],
    ['opus stereo level 0 in webm (60s)', 'q0.webm', ['-i', 'tone.wav', '-c:a', 'libopus', '-b:a', '96k', '-compression_level', '0', 'q0.webm']],
    ['mp4 still 1280x720 1fps (60s, cover pre-sized)', 'y1.mp4', ['-loop', '1', '-framerate', '1', '-i', 'cover720.png', '-i', 'tone.wav', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '1', '-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '160k', '-movflags', '+faststart', 'y1.mp4']],
    ['mp4 still 1920x1080 1fps (60s)', 'y2.mp4', ['-loop', '1', '-framerate', '1', '-i', 'cover1080.png', '-i', 'tone.wav', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '1', '-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '160k', '-movflags', '+faststart', 'y2.mp4']],
    ['mp4 waves overlay 1280x720 6fps (60s)', 'y3.mp4', ['-loop', '1', '-framerate', '6', '-i', 'cover720.png', '-i', 'tone.wav', '-filter_complex', '[1:a]showwaves=s=1280x240:mode=cline:rate=6:colors=0xefb379[w];[0:v][w]overlay=0:400:shortest=1,format=yuv420p[v]', '-map', '[v]', '-map', '1:a', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-r', '6', '-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '160k', '-movflags', '+faststart', 'y3.mp4']],
    ['webm still vp8 1280x720 1fps + vorbis (60s)', 'y4.webm', ['-loop', '1', '-framerate', '1', '-i', 'cover720.png', '-i', 'tone.wav', '-t', '60', '-c:v', 'libvpx', '-b:v', '400k', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p', '-r', '1', '-c:a', 'libvorbis', '-q:a', '5', 'y4.webm']],
    ['m4a aac twoloop 160k (60s) baseline', 'y5.m4a', ['-i', 'tone.wav', '-c:a', 'aac', '-b:a', '160k', 'y5.m4a']],
    ['mp3 192k (60s) baseline', 'y6.mp3', ['-i', 'tone.wav', '-c:a', 'libmp3lame', '-b:a', '192k', 'y6.mp3']],
  ];
  // set4: Opus robustness with the exact options the app uses (stereo level 0, mono level 10, VBR on, 48 kHz).
  const ST = ['-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-vbr', 'on', '-compression_level', '0'];
  const MO = ['-c:a', 'libopus', '-ar', '48000', '-ac', '1', '-vbr', 'on', '-compression_level', '10'];
  const trials4 = [
    ['stereo L0 96k · noise 48k', 'a1.opus', ['-i', 'noise48.wav', ...ST, '-b:a', '96k', 'a1.opus']],
    ['stereo L0 96k · chirp 44.1k (resample)', 'a2.opus', ['-i', 'chirp44.wav', ...ST, '-b:a', '96k', 'a2.opus']],
    ['stereo L0 96k · speech 22.05k mono → stereo', 'a3.opus', ['-i', 'speech22m.wav', ...ST, '-b:a', '96k', 'a3.opus']],
    ['stereo L0 96k · speech 16k mono → stereo', 'a4.opus', ['-i', 'speech16m.wav', ...ST, '-b:a', '96k', 'a4.opus']],
    ['stereo L0 128k · 5.1 48k → stereo', 'a5.opus', ['-i', 'mix51.wav', ...ST, '-b:a', '128k', 'a5.opus']],
    ['stereo L0 96k · silence', 'a6.opus', ['-i', 'silence48.wav', ...ST, '-b:a', '96k', 'a6.opus']],
    ['stereo L0 96k · clipped 44.1k', 'a7.opus', ['-i', 'clip44.wav', ...ST, '-b:a', '96k', 'a7.opus']],
    ['stereo L0 96k · 96 kHz source', 'a8.opus', ['-i', 'mix96.wav', ...ST, '-b:a', '96k', 'a8.opus']],
    ['stereo L0 32k · noise', 'a9.opus', ['-i', 'noise48.wav', ...ST, '-b:a', '32k', 'a9.opus']],
    ['stereo L0 48k · chirp', 'a10.opus', ['-i', 'chirp44.wav', ...ST, '-b:a', '48k', 'a10.opus']],
    ['stereo L0 256k · noise', 'a11.opus', ['-i', 'noise48.wav', ...ST, '-b:a', '256k', 'a11.opus']],
    ['stereo L0 96k · 300 s long mix', 'a12.opus', ['-i', 'long300.wav', ...ST, '-b:a', '96k', 'a12.opus']],
    ['stereo L0 96k · float32 input (app temp file path)', 'a13.opus', ['-i', 'chirp44.wav', '-c:a', 'pcm_f32le', '-ar', '48000', 'tmpf32.wav'], 'then'],
    ['webm stereo L0 · speech 22.05k', 'a14.webm', ['-i', 'speech22m.wav', ...ST, '-b:a', '96k', 'a14.webm']],
    ['mono L10 48k · speech 22.05k', 'b1.opus', ['-i', 'speech22m.wav', ...MO, '-b:a', '48k', 'b1.opus']],
    ['mono L10 64k · noise stereo → mono', 'b2.opus', ['-i', 'noise48.wav', ...MO, '-b:a', '64k', 'b2.opus']],
    ['mono L10 96k · 5.1 → mono', 'b3.opus', ['-i', 'mix51.wav', ...MO, '-b:a', '96k', 'b3.opus']],
    ['mono L10 48k · 300 s long', 'b4.opus', ['-i', 'long300.wav', ...MO, '-b:a', '48k', 'b4.opus']],
    ['mono L10 32k · clipped', 'b5.opus', ['-i', 'clip44.wav', ...MO, '-b:a', '32k', 'b5.opus']],
    ['stereo L0 96k · speech 48k stereo', 'c1.opus', ['-i', 'speech48.wav', ...ST, '-b:a', '96k', 'c1.opus']],
    ['stereo L0 96k · mix 48k stereo (tone+noise)', 'c2.opus', ['-i', 'mix48.wav', ...ST, '-b:a', '96k', 'c2.opus']],
    ['mono L10 96k · noise 48k mono', 'c3.opus', ['-i', 'noise48m.wav', ...MO, '-b:a', '96k', 'c3.opus']],
    ['mono L0 96k · noise 48k mono', 'c4.opus', ['-i', 'noise48m.wav', '-c:a', 'libopus', '-ar', '48000', '-ac', '1', '-vbr', 'on', '-compression_level', '0', '-b:a', '96k', 'c4.opus']],
    ['stereo L0 VBR off · noise', 'c5.opus', ['-i', 'noise48.wav', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-vbr', 'off', '-compression_level', '0', '-b:a', '96k', 'c5.opus']],
    ['stereo L0 voip · noise', 'c6.opus', ['-i', 'noise48.wav', ...ST, '-application', 'voip', '-b:a', '96k', 'c6.opus']],
    ['stereo L0 lowdelay · noise', 'c7.opus', ['-i', 'noise48.wav', ...ST, '-application', 'lowdelay', '-b:a', '96k', 'c7.opus']],
    ['stereo L0 frame 60 ms · noise', 'c8.opus', ['-i', 'noise48.wav', ...ST, '-frame_duration', '60', '-b:a', '96k', 'c8.opus']],
    ['stereo L0 mapping_family 255 (2 coupled→separate) · noise', 'c9.opus', ['-i', 'noise48.wav', ...ST, '-mapping_family', '255', '-b:a', '96k', 'c9.opus']],
    ['native opus encoder (-strict -2) stereo · noise', 'c10.opus', ['-i', 'noise48.wav', '-c:a', 'opus', '-strict', '-2', '-ar', '48000', '-ac', '2', '-b:a', '96k', 'c10.opus']],
    ['native opus encoder stereo · speech 22.05k → stereo', 'c11.opus', ['-i', 'speech22m.wav', '-c:a', 'opus', '-strict', '-2', '-ar', '48000', '-ac', '2', '-b:a', '96k', 'c11.opus']],
    ['native opus encoder stereo · 300 s long', 'c12.opus', ['-i', 'long300.wav', '-c:a', 'opus', '-strict', '-2', '-ar', '48000', '-ac', '2', '-b:a', '96k', 'c12.opus']],
    ['native opus encoder mono · noise', 'c13.opus', ['-i', 'noise48m.wav', '-c:a', 'opus', '-strict', '-2', '-ar', '48000', '-ac', '1', '-b:a', '64k', 'c13.opus']],
    ['DECODE: .opus (mono) → WAV  [Opus input]', 'd1.wav', ['-i', 'speech22m.wav', ...MO, '-b:a', '64k', 'src1.opus'], 'then'],
    ['DECODE: .webm opus → WAV  [mic recording input]', 'd2.wav', ['-i', 'speech22m.wav', ...MO, '-b:a', '64k', 'src2.webm'], 'then'],
    ['DECODE: native-encoded stereo .opus → WAV', 'd4.wav', ['-i', 'chirp44.wav', '-c:a', 'opus', '-strict', '-2', '-ar', '48000', '-ac', '2', '-b:a', '96k', 'src4.opus'], 'then'],
    ['DECODE: .opus → MP3  [Opus MP3 변환기]', 'd3.mp3', ['-i', 'chirp44.wav', ...MO, '-b:a', '64k', 'src3.opus'], 'then'],
  ];
  Object.assign(chained, {
    'a13.opus': ['-i', 'tmpf32.wav', ...ST, '-b:a', '96k', 'a13.opus'],
    'd1.wav': ['-i', 'src1.opus', '-c:a', 'pcm_s16le', 'd1.wav'],
    'd2.wav': ['-i', 'src2.webm', '-c:a', 'pcm_s16le', 'd2.wav'],
    'd3.mp3': ['-i', 'src3.opus', '-c:a', 'libmp3lame', '-b:a', '128k', 'd3.mp3'],
    'd4.wav': ['-i', 'src4.opus', '-c:a', 'pcm_s16le', 'd4.wav'],
  });
  const trials = location.hash === '#set2' ? trials2 : location.hash === '#set3' ? trials3 : location.hash === '#set4' ? trials4 : trials1;
  const out = $('trials');
  let index = 0;
  function next() {
    if (index >= trials.length) { $('state').textContent = '모든 시험을 마쳤습니다.'; document.title = 'CAPS DONE'; return; }
    const [name, file, args, mode] = trials[index++];
    $('state').textContent = `시험 중 (${index}/${trials.length}): ${name}`;
    worker.postMessage({ type: 'trial', name, out: file, args, keep: mode === 'then', then: mode === 'then' ? chained[file] : null });
  }
  worker.onmessage = ({ data }) => {
    if (data.type === 'lists') {
      for (const key of Object.keys(data.lists)) $(key).textContent = data.lists[key];
      next();
    } else if (data.type === 'trial') {
      out.textContent += `${data.ok ? 'OK  ' : 'FAIL'} ${data.name} · ${data.ms} ms · ${data.size} B\n${data.probe ? '     ' + data.probe.trim().replace(/\n/g, '\n     ') + '\n' : ''}${data.tail ? '     ' + data.tail.replace(/\n/g, '\n     ') + '\n' : ''}`;
      next();
    }
  };
  worker.onerror = e => { $('state').textContent = 'Worker 오류: ' + e.message; document.title = 'CAPS ERROR'; };
  worker.postMessage({ type: 'init', seconds: location.hash === '#set3' ? 60 : 8, opusSet: location.hash === '#set4' });
})();
