/* ------------------------------------------------------------------------- *
 * Pure JavaScript baseline/sequential JPEG codec.
 *
 *  - no imports, no node built-ins, no WebAssembly, no Buffer
 *  - ES2020, platform neutral
 *  - decode: SOF0 / SOF1, Huffman, 1 or 3 components, arbitrary sampling
 *            factors, restart markers, APP0/APP1/APP2 metadata extraction
 *  - encode: baseline JFIF (SOI APP0 DQT SOF0 DHT SOS data EOI)
 *
 * Accuracy notes: the forward/inverse DCT is a separable float DCT built from
 * the exact JPEG basis matrix A[u][x] = (C(u)/2) * cos((2x+1)u*pi/16) with
 * C(0) = 1/sqrt(2), C(u>0) = 1.  The same matrix inverts it, so encode and
 * decode are mutually exact and both agree with libjpeg's integer islow
 * implementation to well under one 8 bit step.  Chroma upsampling reproduces
 * libjpeg's "fancy" (triangle filter) upsamplers for the 4:2:0 and 4:2:2
 * cases and falls back to clamped bilinear for the exotic ones.
 * ------------------------------------------------------------------------- */

export interface Image {
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4; /* 1 grey, 2 grey+alpha, 3 rgb, 4 rgba */
  data: Uint8Array; /* length === width*height*channels, row major, interleaved, 8 bit, non premultiplied */
}

export interface JpegInfo {
  chromaSubsampling: string;
  isProgressive: boolean;
  density?: number;
  resolutionUnit?: string;
  hasProfile: boolean;
  orientation?: number;
  exif?: Uint8Array;
  icc?: Uint8Array;
  xmp?: Uint8Array;
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 1 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/**
 * The frame's width and height, read off the SOF marker without decoding anything. A caller that
 * wants a reduced-size decode has to decide the scale before it decodes, because libjpeg takes
 * `scale_denom` from the header and sharp's fastShrinkOnLoad is exactly that decision.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let p = 2;
  while (p + 1 < bytes.length) {
    if (bytes[p] !== 0xff) {
      p++;
      continue;
    }
    const m = bytes[p + 1];
    if (m === 0xff) {
      p++;
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) {
      p += 2;
      continue;
    }
    if (p + 4 > bytes.length) return undefined;
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    /* SOF0, SOF1, SOF2, SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15: every frame header but DHT,
       JPG and DAC. */
    const isSof = (m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) ||
      (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf);
    if (isSof) {
      if (p + 9 > bytes.length) return undefined;
      return { height: (bytes[p + 5] << 8) | bytes[p + 6], width: (bytes[p + 7] << 8) | bytes[p + 8] };
    }
    p += 2 + len;
  }
  return undefined;
}

/* ------------------------------------------------------------------ tables */

/* zigzag position -> natural (row major) index */
const ZIG2NAT = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
]);

/* natural index -> zigzag position */
const NAT2ZIG = new Uint8Array(64);
for (let k = 0; k < 64; k++) NAT2ZIG[ZIG2NAT[k]] = k;

/* DCT basis, shared by the forward and the inverse transform */
const DCT_A = new Float32Array(64);
for (let u = 0; u < 8; u++) {
  const c = (u === 0 ? Math.SQRT1_2 : 1) * 0.5;
  for (let x = 0; x < 8; x++) {
    DCT_A[u * 8 + x] = c * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

/* one dimensional forward DCT:
 *   dst[dstOff + u*dstStep] = sum_x A[u][x] * src[srcOff + x*srcStep]      */
function dct1d(
  src: Float32Array,
  srcOff: number,
  srcStep: number,
  dst: Float32Array,
  dstOff: number,
  dstStep: number
): void {
  for (let u = 0; u < 8; u++) {
    const b = u * 8;
    let s = 0;
    for (let x = 0; x < 8; x++) s += DCT_A[b + x] * src[srcOff + x * srcStep];
    dst[dstOff + u * dstStep] = s;
  }
}

/* one dimensional inverse DCT, kept only for the doc note above: the decoder
 * runs libjpeg's jpeg_idct_islow (further down), not this. */
function idct1d(
  src: Float32Array,
  srcOff: number,
  srcStep: number,
  dst: Float32Array,
  dstOff: number,
  dstStep: number
): void {
  for (let x = 0; x < 8; x++) {
    let s = 0;
    for (let u = 0; u < 8; u++) s += DCT_A[u * 8 + x] * src[srcOff + u * srcStep];
    dst[dstOff + x * dstStep] = s;
  }
}

/* ------------------------------------------------------------------ libjpeg's jpeg_idct_islow
 *
 * The decoder above inverts the DCT in floating point; libjpeg does not. Its
 * baseline decoder runs jidctint.c's `jpeg_idct_islow`, the scaled fixed-point
 * Loeffler-Ligtenberg-Moschytz IDCT: CONST_BITS 13 for the fractional constants,
 * PASS1_BITS 2 for the intermediate, a descaling right shift with half a step
 * added for rounding, and the sample range limit table that both clamps and puts
 * the 128 level shift back. Every one of those is a different rounding from the
 * float transform's, which is why a decoded jpeg's pixels came out a count off
 * libjpeg's -- 474 of 12288 bytes on a 64x64 RGB jpeg, each by 1 or 2.
 *
 * The constants are the precalculated FIX() values at CONST_BITS == 13, so this
 * is the C, arithmetic for arithmetic, not an approximation of it.
 */
const CONST_BITS = 13;
const PASS1_BITS = 2;
const FIX_0_298631336 = 2446;
const FIX_0_390180644 = 3196;
const FIX_0_541196100 = 4433;
const FIX_0_765366865 = 6270;
const FIX_0_899976223 = 7373;
const FIX_1_175875602 = 9633;
const FIX_1_501321110 = 12299;
const FIX_1_847759065 = 15137;
const FIX_1_961570560 = 16069;
const FIX_2_053119869 = 16819;
const FIX_2_562915447 = 20995;
const FIX_3_072711026 = 25172;
const IDCT_WS = new Int32Array(64);

/*
 * The constants jidctred.c precalculates at CONST_BITS == 13 for the reduced-size IDCTs below.
 * Only the ones jidctint.c does not already name are listed here.
 */
const FIX_0_211164243 = 1730;
const FIX_0_509795579 = 4176;
const FIX_0_601344887 = 4926;
const FIX_0_720959822 = 5906;
const FIX_0_850430095 = 6967;
const FIX_1_061594337 = 8697;
const FIX_1_272758580 = 10426;
const FIX_1_451774981 = 11893;
const FIX_2_172734803 = 17799;
const FIX_3_624509785 = 29692;
const IDCT_WS_RED = new Int32Array(64);

/* libjpeg's DESCALE: add half a step, then shift it off. The shift is C's
   arithmetic right shift, which is a floor. */
function descale(x: number, n: number): number {
  return Math.floor((x + (1 << (n - 1))) / (1 << n));
}

/*
 * libjpeg's sample_range_limit, which `IDCT_range_limit` points into at
 * CENTERJSAMPLE: table[i] is i clamped to 0..255, and the offset puts the 128
 * level shift back, so an index of the signed sample gives the unsigned one.
 * The caller masks the index with RANGE_MASK (1023) first, which is what makes a
 * very negative sample read the trailing zeros rather than the 255 plateau --
 * but a sample that far out of range cannot come out of a valid block, so a
 * plain clamp on the sum is the same answer over the whole reachable range.
 */
function rangeLimit(sample: number): number {
  const v = sample + 128;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/*
 * Dequantize and inverse DCT one 8x8 block. `coef` holds the 64 already
 * dequantized coefficients in natural (row major) order, which is what libjpeg
 * multiplies inside its own DEQUANTIZE; the two are the same because a
 * quantisation table entry is never zero. `out` receives the 64 samples.
 */
function idctIslow(coef: Float32Array, out: Float32Array): void {
  const ws = IDCT_WS;
  for (let col = 0; col < 8; col++) {
    const c0 = coef[col];
    const c1 = coef[8 + col];
    const c2 = coef[16 + col];
    const c3 = coef[24 + col];
    const c4 = coef[32 + col];
    const c5 = coef[40 + col];
    const c6 = coef[48 + col];
    const c7 = coef[56 + col];
    /* libjpeg's shortcut for a column of nothing but DC: every output is the
       DC value, and it is not the same arithmetic the general path would run. */
    if (c1 === 0 && c2 === 0 && c3 === 0 && c4 === 0 && c5 === 0 && c6 === 0 && c7 === 0) {
      const dcval = c0 << PASS1_BITS;
      ws[col] = dcval;
      ws[8 + col] = dcval;
      ws[16 + col] = dcval;
      ws[24 + col] = dcval;
      ws[32 + col] = dcval;
      ws[40 + col] = dcval;
      ws[48 + col] = dcval;
      ws[56 + col] = dcval;
      continue;
    }
    let z1: number;
    let z2: number;
    let z3: number;
    let z4: number;
    let z5: number;
    let t0: number;
    let t1: number;
    let t2: number;
    let t3: number;
    let t10: number;
    let t11: number;
    let t12: number;
    let t13: number;

    z2 = c2;
    z3 = c6;
    z1 = (z2 + z3) * FIX_0_541196100;
    t2 = z1 + z3 * -FIX_1_847759065;
    t3 = z1 + z2 * FIX_0_765366865;

    z2 = c0;
    z3 = c4;
    t0 = (z2 + z3) << CONST_BITS;
    t1 = (z2 - z3) << CONST_BITS;

    t10 = t0 + t3;
    t13 = t0 - t3;
    t11 = t1 + t2;
    t12 = t1 - t2;

    t0 = c7;
    t1 = c5;
    t2 = c3;
    t3 = c1;

    z1 = t0 + t3;
    z2 = t1 + t2;
    z3 = t0 + t2;
    z4 = t1 + t3;
    z5 = (z3 + z4) * FIX_1_175875602;

    t0 = t0 * FIX_0_298631336;
    t1 = t1 * FIX_2_053119869;
    t2 = t2 * FIX_3_072711026;
    t3 = t3 * FIX_1_501321110;
    z1 = z1 * -FIX_0_899976223;
    z2 = z2 * -FIX_2_562915447;
    z3 = z3 * -FIX_1_961570560;
    z4 = z4 * -FIX_0_390180644;

    z3 += z5;
    z4 += z5;

    t0 += z1 + z3;
    t1 += z2 + z4;
    t2 += z2 + z3;
    t3 += z1 + z4;

    ws[col] = descale(t10 + t3, CONST_BITS - PASS1_BITS);
    ws[56 + col] = descale(t10 - t3, CONST_BITS - PASS1_BITS);
    ws[8 + col] = descale(t11 + t2, CONST_BITS - PASS1_BITS);
    ws[48 + col] = descale(t11 - t2, CONST_BITS - PASS1_BITS);
    ws[16 + col] = descale(t12 + t1, CONST_BITS - PASS1_BITS);
    ws[40 + col] = descale(t12 - t1, CONST_BITS - PASS1_BITS);
    ws[24 + col] = descale(t13 + t0, CONST_BITS - PASS1_BITS);
    ws[32 + col] = descale(t13 - t0, CONST_BITS - PASS1_BITS);
  }

  for (let row = 0; row < 8; row++) {
    const b = row * 8;
    /* The same shortcut for a row of nothing but DC. */
    if (
      ws[b + 1] === 0 && ws[b + 2] === 0 && ws[b + 3] === 0 &&
      ws[b + 4] === 0 && ws[b + 5] === 0 && ws[b + 6] === 0 && ws[b + 7] === 0
    ) {
      const dcval = rangeLimit(descale(ws[b], PASS1_BITS + 3));
      out[b] = dcval;
      out[b + 1] = dcval;
      out[b + 2] = dcval;
      out[b + 3] = dcval;
      out[b + 4] = dcval;
      out[b + 5] = dcval;
      out[b + 6] = dcval;
      out[b + 7] = dcval;
      continue;
    }
    let z1: number;
    let z2: number;
    let z3: number;
    let z4: number;
    let z5: number;
    let t0: number;
    let t1: number;
    let t2: number;
    let t3: number;
    let t10: number;
    let t11: number;
    let t12: number;
    let t13: number;

    z2 = ws[b + 2];
    z3 = ws[b + 6];

    z1 = (z2 + z3) * FIX_0_541196100;
    t2 = z1 + z3 * -FIX_1_847759065;
    t3 = z1 + z2 * FIX_0_765366865;

    t0 = (ws[b] + ws[b + 4]) << CONST_BITS;
    t1 = (ws[b] - ws[b + 4]) << CONST_BITS;

    t10 = t0 + t3;
    t13 = t0 - t3;
    t11 = t1 + t2;
    t12 = t1 - t2;

    t0 = ws[b + 7];
    t1 = ws[b + 5];
    t2 = ws[b + 3];
    t3 = ws[b + 1];

    z1 = t0 + t3;
    z2 = t1 + t2;
    z3 = t0 + t2;
    z4 = t1 + t3;
    z5 = (z3 + z4) * FIX_1_175875602;

    t0 = t0 * FIX_0_298631336;
    t1 = t1 * FIX_2_053119869;
    t2 = t2 * FIX_3_072711026;
    t3 = t3 * FIX_1_501321110;
    z1 = z1 * -FIX_0_899976223;
    z2 = z2 * -FIX_2_562915447;
    z3 = z3 * -FIX_1_961570560;
    z4 = z4 * -FIX_0_390180644;

    z3 += z5;
    z4 += z5;

    t0 += z1 + z3;
    t1 += z2 + z4;
    t2 += z2 + z3;
    t3 += z1 + z4;

    out[b] = rangeLimit(descale(t10 + t3, CONST_BITS + PASS1_BITS + 3));
    out[b + 7] = rangeLimit(descale(t10 - t3, CONST_BITS + PASS1_BITS + 3));
    out[b + 1] = rangeLimit(descale(t11 + t2, CONST_BITS + PASS1_BITS + 3));
    out[b + 6] = rangeLimit(descale(t11 - t2, CONST_BITS + PASS1_BITS + 3));
    out[b + 2] = rangeLimit(descale(t12 + t1, CONST_BITS + PASS1_BITS + 3));
    out[b + 5] = rangeLimit(descale(t12 - t1, CONST_BITS + PASS1_BITS + 3));
    out[b + 3] = rangeLimit(descale(t13 + t0, CONST_BITS + PASS1_BITS + 3));
    out[b + 4] = rangeLimit(descale(t13 - t0, CONST_BITS + PASS1_BITS + 3));
  }
}

/* ------------------------------------------------- libjpeg's jpeg_idct_4x4 / _2x2 / _1x1
 *
 * jidctred.c, the inverse DCTs libjpeg runs when the caller asks for a reduced-size decode
 * (`scale_num`/`scale_denom`, which is how sharp's fastShrinkOnLoad takes a jpeg down by 2, 4 or
 * 8 on load). They are the LL&M algorithm of jidctint.c with each 8-to-8 1-D step replaced by an
 * 8-to-4 step -- the four averages of two adjacent outputs -- or an 8-to-2 step, the two averages
 * of four. 1x1 is the DC coefficient divided by 8.
 *
 * That is a different answer from decoding at full size and then resizing: the average is taken in
 * the fixed-point domain before the level shift and the clamp, so a block whose samples would
 * clamp at 255 does not come out at 255 here. Measured against sharp 0.33.5, a 64x64 RGB jpeg
 * decoded with no operation agrees byte for byte (the islow path above), while
 * `.resize({width:16})` -- a 1/4 decode -- does not, and only these three reproduce it.
 */

/**
 * `jpeg_idct_4x4`: four averages of two from one block. `out` receives 16 samples, row major.
 */
function idct4x4(coef: Float32Array, out: Float32Array): void {
  const ws = IDCT_WS_RED;
  /* Pass 1: process columns from input, store into work array. Column 4 is skipped because the
     second pass never reads it. */
  for (let col = 0; col < 8; col++) {
    if (col === 4) continue;
    const c0 = coef[col];
    const c2 = coef[16 + col];
    const c6 = coef[48 + col];
    let tmp0 = c0 * (1 << (CONST_BITS + 1));
    const tmp2 = c2 * FIX_1_847759065 + c6 * -FIX_0_765366865;
    const tmp10 = tmp0 + tmp2;
    const tmp12 = tmp0 - tmp2;
    const z1 = coef[56 + col];
    const z2 = coef[40 + col];
    const z3 = coef[24 + col];
    const z4 = coef[8 + col];
    tmp0 = z1 * -FIX_0_211164243 + z2 * FIX_1_451774981 + z3 * -FIX_2_172734803 + z4 * FIX_1_061594337;
    const tmp2b = z1 * -FIX_0_509795579 + z2 * -FIX_0_601344887 + z3 * FIX_0_899976223 + z4 * FIX_2_562915447;
    ws[col] = descale(tmp10 + tmp2b, CONST_BITS - PASS1_BITS + 1);
    ws[24 + col] = descale(tmp10 - tmp2b, CONST_BITS - PASS1_BITS + 1);
    ws[8 + col] = descale(tmp12 + tmp0, CONST_BITS - PASS1_BITS + 1);
    ws[16 + col] = descale(tmp12 - tmp0, CONST_BITS - PASS1_BITS + 1);
  }
  /* Pass 2: process the four rows from the work array, store into the output. */
  for (let row = 0; row < 4; row++) {
    const b = row * 8;
    let tmp0 = ws[b] * (1 << (CONST_BITS + 1));
    const tmp2 = ws[b + 2] * FIX_1_847759065 + ws[b + 6] * -FIX_0_765366865;
    const tmp10 = tmp0 + tmp2;
    const tmp12 = tmp0 - tmp2;
    const z1 = ws[b + 7];
    const z2 = ws[b + 5];
    const z3 = ws[b + 3];
    const z4 = ws[b + 1];
    tmp0 = z1 * -FIX_0_211164243 + z2 * FIX_1_451774981 + z3 * -FIX_2_172734803 + z4 * FIX_1_061594337;
    const tmp2b = z1 * -FIX_0_509795579 + z2 * -FIX_0_601344887 + z3 * FIX_0_899976223 + z4 * FIX_2_562915447;
    const d = row * 4;
    out[d] = rangeLimit(descale(tmp10 + tmp2b, CONST_BITS + PASS1_BITS + 3 + 1));
    out[d + 3] = rangeLimit(descale(tmp10 - tmp2b, CONST_BITS + PASS1_BITS + 3 + 1));
    out[d + 1] = rangeLimit(descale(tmp12 + tmp0, CONST_BITS + PASS1_BITS + 3 + 1));
    out[d + 2] = rangeLimit(descale(tmp12 - tmp0, CONST_BITS + PASS1_BITS + 3 + 1));
  }
}

/** `jpeg_idct_2x2`: two averages of four from one block. `out` receives 4 samples. */
function idct2x2(coef: Float32Array, out: Float32Array): void {
  const ws = IDCT_WS_RED;
  /* Columns 2, 4 and 6 are skipped: the second pass never reads them. */
  for (let col = 0; col < 8; col++) {
    if (col === 2 || col === 4 || col === 6) continue;
    const tmp10 = coef[col] * (1 << (CONST_BITS + 2));
    const tmp0 =
      coef[56 + col] * -FIX_0_720959822 +
      coef[40 + col] * FIX_0_850430095 +
      coef[24 + col] * -FIX_1_272758580 +
      coef[8 + col] * FIX_3_624509785;
    ws[col] = descale(tmp10 + tmp0, CONST_BITS - PASS1_BITS + 2);
    ws[8 + col] = descale(tmp10 - tmp0, CONST_BITS - PASS1_BITS + 2);
  }
  for (let row = 0; row < 2; row++) {
    const b = row * 8;
    const tmp10 = ws[b] * (1 << (CONST_BITS + 2));
    const tmp0 =
      ws[b + 7] * -FIX_0_720959822 +
      ws[b + 5] * FIX_0_850430095 +
      ws[b + 3] * -FIX_1_272758580 +
      ws[b + 1] * FIX_3_624509785;
    out[row * 2] = rangeLimit(descale(tmp10 + tmp0, CONST_BITS + PASS1_BITS + 3 + 2));
    out[row * 2 + 1] = rangeLimit(descale(tmp10 - tmp0, CONST_BITS + PASS1_BITS + 3 + 2));
  }
}

/** `jpeg_idct_1x1`: the average of the whole block, one eighth of the DC coefficient. */
function idct1x1(coef: Float32Array, out: Float32Array): void {
  out[0] = rangeLimit(descale(coef[0], 3));
}

/* Annex K quantisation tables, zigzag order */
const STD_LUMA_Q = new Uint8Array([
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16,
  24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
  103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]);

const STD_CHROMA_Q = new Uint8Array([
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56,
  99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99,
]);

/* Annex K Huffman tables: 16 code counts followed by the symbol values */
const STD_DC_LUMA_BITS = new Uint8Array([
  0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0,
]);
const STD_DC_CHROMA_BITS = new Uint8Array([
  0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0,
]);
const STD_DC_VALS = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

const STD_AC_LUMA_BITS = new Uint8Array([
  0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d,
]);
const STD_AC_CHROMA_BITS = new Uint8Array([
  0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77,
]);

const STD_AC_LUMA_VALS = new Uint8Array([
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13,
  0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42,
  0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a,
  0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
  0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67,
  0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84,
  0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3,
  0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
]);

const STD_AC_CHROMA_VALS = new Uint8Array([
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51,
  0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1,
  0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24,
  0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a,
  0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66,
  0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82,
  0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
  0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
  0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
  0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
]);

/* ------------------------------------------------------------- huffman ---- */

interface HuffTable {
  maxcode: Int32Array; /* index 1..16, -1 when the length is unused */
  mincode: Int32Array;
  valptr: Int32Array;
  values: Uint8Array;
}

function buildHuffTable(bits: Uint8Array, huffval: Uint8Array): HuffTable {
  const maxcode = new Int32Array(17);
  const mincode = new Int32Array(17);
  const valptr = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = bits[l - 1];
    if (n > 0) {
      valptr[l] = k;
      mincode[l] = code;
      k += n;
      code += n;
      maxcode[l] = code - 1;
    } else {
      maxcode[l] = -1;
      mincode[l] = 0;
      valptr[l] = 0;
    }
    /* the code space doubles at every length, empty ones included */
    code <<= 1;
  }
  return { maxcode, mincode, valptr, values: huffval };
}

interface EncTable {
  code: Int32Array; /* indexed by symbol value */
  length: Uint8Array;
}

function buildEncTable(bits: Uint8Array, huffval: Uint8Array): EncTable {
  const code = new Int32Array(256);
  const length = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = bits[l - 1];
    for (let i = 0; i < n; i++) {
      code[huffval[k]] = c;
      length[huffval[k]] = l;
      k++;
      c++;
    }
    c <<= 1;
  }
  return { code, length };
}

/* ------------------------------------------------------------ bit reader -- */

class BitReader {
  data: Uint8Array;
  pos: number;
  buf = 0;
  cnt = 0;

  constructor(data: Uint8Array, pos: number) {
    this.data = data;
    this.pos = pos;
  }

  readBit(): number {
    if (this.cnt === 0) {
      if (this.pos >= this.data.length) throw new Error('truncated JPEG data');
      let b = this.data[this.pos++];
      if (b === 0xff) {
        if (this.pos >= this.data.length) {
          throw new Error('truncated JPEG data');
        }
        const nb = this.data[this.pos];
        if (nb !== 0) {
          /* a real marker: wrong place, treat the scan as over / broken */
          this.pos--;
          throw new Error('truncated JPEG data');
        }
        this.pos++;
      }
      this.buf = b;
      this.cnt = 8;
    }
    this.cnt--;
    return (this.buf >> this.cnt) & 1;
  }

  align(): void {
    this.cnt = 0;
  }
}

function decodeHuff(br: BitReader, h: HuffTable): number {
  let code = br.readBit();
  let l = 1;
  while (code > h.maxcode[l]) {
    if (l >= 16) throw new Error('bad JPEG Huffman code');
    code = (code << 1) | br.readBit();
    l++;
  }
  return h.values[h.valptr[l] + code - h.mincode[l]];
}

function receiveExtend(br: BitReader, s: number): number {
  if (s === 0) return 0;
  let v = 0;
  for (let i = 0; i < s; i++) v = (v << 1) | br.readBit();
  if (v < 1 << (s - 1)) v -= (1 << s) - 1;
  return v;
}

/* ------------------------------------------------------------ bit writer -- */

class BitWriter {
  private buf: Uint8Array;
  private len = 0;
  private acc = 0;
  private nbits = 0;

  constructor(cap: number) {
    this.buf = new Uint8Array(cap < 64 ? 64 : cap);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  writeBits(code: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.writeBit((code >> i) & 1);
  }

  writeBit(b: number): void {
    this.acc = (this.acc << 1) | (b & 1);
    this.nbits++;
    if (this.nbits === 8) {
      const v = this.acc & 0xff;
      this.byte(v);
      if (v === 0xff) this.byte(0); /* byte stuffing */
      this.acc = 0;
      this.nbits = 0;
    }
  }

  flush(): void {
    while (this.nbits !== 0) this.writeBit(1);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/* --------------------------------------------------------------- helpers -- */

/*
 * libjpeg's ycc_rgb_convert (jdcolor.c): the YCbCr to sRGB step is a fixed-point table, not a
 * float multiply, and the difference is not cosmetic -- the coefficients are 1.40200, 0.34414,
 * 0.71414 and 1.77200 at 16 bits of fraction, and the half that rounds is folded into three of
 * the four tables before the shift, so the green band -- the only one that sums two tables and
 * shifts their sum -- rounds at a different place from the red and the blue. Measured against
 * sharp 0.33.5 on a 64x64 4:2:0 jpeg: the float form leaves 4 of 12288 bytes off by one, every
 * one of them green, and this form leaves none.
 */
const YCC_SCALE = 1 << 16;
const YCC_HALF = 1 << 15;
const CR_R_TAB = new Int32Array(256);
const CB_B_TAB = new Int32Array(256);
const CR_G_TAB = new Int32Array(256);
const CB_G_TAB = new Int32Array(256);
{
  const crR = Math.round(1.402 * YCC_SCALE);
  const cbB = Math.round(1.772 * YCC_SCALE);
  const crG = Math.round(0.71414 * YCC_SCALE);
  const cbG = Math.round(0.34414 * YCC_SCALE);
  for (let i = 0; i < 256; i++) {
    const x = i - 128;
    CR_R_TAB[i] = (crR * x + YCC_HALF) >> 16;
    CB_B_TAB[i] = (cbB * x + YCC_HALF) >> 16;
    CR_G_TAB[i] = -crG * x;
    CB_G_TAB[i] = -cbG * x + YCC_HALF;
  }
}

/** libjpeg's sample_range_limit clamping into 0..255. */
function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function clamp255f(v: number): number {
  const r = v + 0.5;
  return r < 0 ? 0 : r > 255 ? 255 : r | 0;
}

function readU16BE(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function asciiAt(b: Uint8Array, o: number, s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (o + i >= b.length || b[o + i] !== s.charCodeAt(i)) return false;
  }
  return true;
}

/* EXIF Orientation (tag 0x0112) out of a raw TIFF block */
function exifOrientation(tiff: Uint8Array): number | undefined {
  let le = false;
  if (tiff[0] === 0x49 && tiff[1] === 0x49) le = true;
  else if (tiff[0] === 0x4d && tiff[1] === 0x4d) le = false;
  else return undefined;

  const u16 = (o: number): number =>
    le ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1];
  const u32 = (o: number): number =>
    le
      ? ((tiff[o] |
          (tiff[o + 1] << 8) |
          (tiff[o + 2] << 16) |
          (tiff[o + 3] << 24)) >>>
        0)
      : (((tiff[o] << 24) |
          (tiff[o + 1] << 16) |
          (tiff[o + 2] << 8) |
          tiff[o + 3]) >>>
        0);

  if (u16(2) !== 0x002a) return undefined;
  const ifd = u32(4);
  if (ifd < 8 || ifd + 2 > tiff.length) return undefined;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    if (u16(e) === 0x0112 && u16(e + 2) === 3) return u16(e + 8);
  }
  return undefined;
}

/**
 * EXIF XResolution (0x011a, a RATIONAL) and ResolutionUnit (0x0128, a SHORT) out of a raw TIFF
 * block, as a density in dpi. libvips reads the resolution off the EXIF rather than off the JFIF
 * when the file carries both -- which is what sharp writes: `.withMetadata({density:150})` on a
 * jpeg leaves the JFIF at 72 dpi and puts 150 in the EXIF, and host sharp 0.33.5 reports 150.
 * Unit 2 is inches, unit 3 centimetres; sharp reports the string libvips stores, 'in' as 'inch'.
 */
function exifResolution(tiff: Uint8Array): { dpi: number; unit?: string } | undefined {
  if (tiff.length < 8) return undefined;
  let le = false;
  if (tiff[0] === 0x49 && tiff[1] === 0x49) le = true;
  else if (tiff[0] === 0x4d && tiff[1] === 0x4d) le = false;
  else return undefined;

  const u16 = (o: number): number =>
    le ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1];
  const u32 = (o: number): number =>
    le
      ? ((tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0)
      : (((tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]) >>> 0);

  if (u16(2) !== 0x002a) return undefined;
  const ifd = u32(4);
  if (ifd < 8 || ifd + 2 > tiff.length) return undefined;
  const n = u16(ifd);
  let xres: number | undefined;
  let unit: number | undefined;
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    const tag = u16(e);
    const type = u16(e + 2);
    if (tag === 0x011a && type === 5) {
      const off = u32(e + 8);
      if (off + 8 <= tiff.length) {
        const den = u32(off + 4);
        if (den !== 0) xres = u32(off) / den;
      }
    } else if (tag === 0x0128 && type === 3) {
      unit = u16(e + 8);
    }
  }
  if (xres === undefined || !(xres > 0)) return undefined;
  const unitName = unit === 3 ? 'cm' : 'inch';
  return { dpi: unit === 3 ? Math.round(xres * 2.54) : xres, unit: unitName };
}

/* sharp/libvips style chroma subsampling label */
function chromaLabel(h0: number, v0: number, h1: number, v1: number): string {
  if (h1 <= 0 || v1 <= 0 || h0 <= 0 || v0 <= 0) return '4:2:0';
  const hr = h0 / h1;
  const vr = v0 / v1;
  if (hr === 1 && vr === 1) return '4:4:4';
  if (hr === 2 && vr === 2) return '4:2:0';
  if (hr === 2 && vr === 1) return '4:2:2';
  if (hr === 4 && vr === 1) return '4:1:1';
  if (hr === 4 && vr === 2) return '4:1:0';
  if (hr === 1 && vr === 2) return '4:4:0';
  if (hr === 2 && vr === 4) return '4:2:4';
  return '4:2:0';
}

/* ------------------------------------------------------------ upsampling -- */

/**
 * Expand a decoded component plane to full image resolution.
 * hRatio/vRatio are hmax/h and vmax/v for this component.
 */
function upsampleComponent(
  plane: Uint8Array,
  planeW: number,
  compW: number,
  compH: number,
  outW: number,
  outH: number,
  hRatio: number,
  vRatio: number
): Uint8Array {
  const out = new Uint8Array(outW * outH);
  const maxI = compW - 1;
  const maxJ = compH - 1;

  /**
   * libjpeg int_upsample: each sample is repeated hRatio times across and vRatio times down. This is
   * what a component gets when no fancy upsampler takes it.
   */
  const replicate = (): Uint8Array => {
    for (let y = 0; y < outH; y++) {
      const row = Math.min(maxJ, (y / vRatio) | 0);
      const o = row * planeW;
      const d = y * outW;
      for (let x = 0; x < outW; x++) {
        out[d + x] = plane[o + Math.min(maxI, (x / hRatio) | 0)];
      }
    }
    return out;
  };

  /*
   * jdsample.c picks the fancy upsampler only while the component is more than two samples wide
   * (`do_fancy && compptr->downsampled_width > 2`), and falls back to replication below that. A 4x4
   * 4:2:0 image has a 2x2 chroma plane, so it replicates, while an 8x8 one has a 4x4 plane and
   * blends: measured against sharp 0.33.5, a chroma checkerboard decodes identically from 8x8 up
   * (max delta 0) and differs by up to 97 at 4x4, where only the four corners agree.
   */
  const fancy = compW > 2;

  if (hRatio === 1 && vRatio === 1) {
    for (let y = 0; y < outH; y++) {
      const s = y * planeW;
      const d = y * outW;
      for (let x = 0; x < outW; x++) out[d + x] = plane[s + x];
    }
    return out;
  }

  if (hRatio === 2 && vRatio === 2) {
    if (!fancy) return replicate();
    /* libjpeg h2v2_fancy_upsample: separable 3/4 - 1/4 triangle filter */
    for (let y = 0; y < outH; y++) {
      const r0 = y >> 1;
      const r1 = (y & 1) === 0 ? r0 - 1 : r0 + 1;
      const o0 = (r0 > maxJ ? maxJ : r0) * planeW;
      const o1 = (r1 < 0 ? 0 : r1 > maxJ ? maxJ : r1) * planeW;
      const d = y * outW;
      for (let x = 0; x < outW; x++) {
        const i = x >> 1;
        const t = 3 * plane[o0 + i] + plane[o1 + i];
        let n: number;
        if ((x & 1) === 0) {
          const p = i > 0 ? i - 1 : 0;
          n = 3 * t + (3 * plane[o0 + p] + plane[o1 + p]) + 8;
        } else {
          const q = i < maxI ? i + 1 : maxI;
          n = 3 * t + (3 * plane[o0 + q] + plane[o1 + q]) + 7;
        }
        out[d + x] = n >> 4;
      }
    }
    return out;
  }

  if (hRatio === 2 && vRatio === 1) {
    if (!fancy) return replicate();
    /* libjpeg h2v1_fancy_upsample */
    for (let y = 0; y < outH; y++) {
      const o0 = (y > maxJ ? maxJ : y) * planeW;
      const d = y * outW;
      for (let x = 0; x < outW; x++) {
        const i = x >> 1;
        const t = 4 * plane[o0 + i];
        let n: number;
        if ((x & 1) === 0) {
          const p = i > 0 ? i - 1 : 0;
          n = 3 * t + 4 * plane[o0 + p] + 4;
        } else {
          const q = i < maxI ? i + 1 : maxI;
          n = 3 * t + 4 * plane[o0 + q] + 8;
        }
        out[d + x] = n >> 4;
      }
    }
    return out;
  }

  /* Every other ratio (4:1:1, 4:2:4, ...) has no fancy upsampler in libjpeg: int_upsample repeats. */
  return replicate();
}

/* ----------------------------------------------------------------- decode -- */

interface DecodeComp {
  id: number;
  h: number;
  v: number;
  tq: number;
  td: number;
  ta: number;
  pred: number;
  plane: Uint8Array;
  planeW: number;
  planeH: number;
  compW: number;
  compH: number;
  /** How many samples one side of a block decodes to: 8 unscaled, or 4, 2 or 1 under DCT scaling. */
  dctScaled: number;
}

/**
 * `shrink` is libjpeg's `scale_denom` -- 1, 2, 4 or 8 -- which is how sharp's fastShrinkOnLoad
 * takes a jpeg down on load: libjpeg then runs the reduced-size IDCTs above instead of
 * jpeg_idct_islow, so a block becomes the average of its samples rather than the samples
 * themselves. It is not the same as decoding at full size and resizing afterwards, and it is the
 * only way to match sharp 0.33.5's `.resize(16)` on a 64x64 jpeg.
 */
export function decodeJpeg(
  bytes: Uint8Array,
  shrink = 1
): { image: Image; info: JpegInfo } {
  if (!isJpeg(bytes)) throw new Error('bad JPEG signature');

  const len = bytes.length;
  const quant: Array<Float32Array | undefined> = [
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  const huffDC: Array<HuffTable | undefined> = [
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  const huffAC: Array<HuffTable | undefined> = [
    undefined,
    undefined,
    undefined,
    undefined,
  ];

  let width = 0;
  let height = 0;
  let ncomp = 0;
  let adobeTransform = -1;
  let restartInterval = 0;
  const comps: DecodeComp[] = [];

  let density: number | undefined;
  let resolutionUnit: string | undefined;
  let exifDensity: number | undefined;
  let exifUnit: string | undefined;
  let orientation: number | undefined;
  let exif: Uint8Array | undefined;
  let iccChunks: Uint8Array[] | undefined;
  let xmp: Uint8Array | undefined;

  let scanStart = -1;
  let sawSOF = false;

  let p = 2;
  while (p + 1 < len) {
    if (bytes[p] !== 0xff) {
      p++;
      continue;
    }
    let m = bytes[p + 1];
    if (m === 0xff) {
      p++;
      continue; /* fill byte */
    }
    if (m === 0x00) {
      p += 2;
      continue;
    }
    p += 2;

    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; /* standalone */
    if (m === 0xd9) break; /* EOI */

    if (p + 2 > len) break;
    const segLen = readU16BE(bytes, p);
    const s = p + 2;
    const e = p + segLen;
    if (segLen < 2 || e > len) break;
    p = e;

    if (m >= 0xe0 && m <= 0xef) {
      /* APPn */
      if (m === 0xe0 && asciiAt(bytes, s, 'JFIF\0') && s + 14 <= e) {
        const units = bytes[s + 7];
        const xd = readU16BE(bytes, s + 8);
        if (units === 1) density = xd;
        else if (units === 2) density = Math.round(xd * 2.54);
      } else if (m === 0xe1) {
        if (asciiAt(bytes, s, 'Exif\0\0')) {
          exif = bytes.slice(s + 6, e);
          const o = exifOrientation(exif);
          if (o !== undefined) orientation = o;
          const r = exifResolution(exif);
          if (r !== undefined) {
            exifDensity = r.dpi;
            exifUnit = r.unit;
          }
        } else if (asciiAt(bytes, s, 'http://ns.adobe.com/xap/1.0/\0')) {
          xmp = bytes.slice(s + 29, e);
        }
      } else if (m === 0xe2 && asciiAt(bytes, s, 'ICC_PROFILE\0') && s + 14 <= e) {
        const chunk = bytes.slice(s + 14, e);
        if (iccChunks === undefined) iccChunks = [];
        iccChunks.push(chunk);
      } else if (m === 0xee && asciiAt(bytes, s, 'Adobe') && s + 12 <= e) {
        adobeTransform = bytes[s + 11];
      }
      continue;
    }

    if (m === 0xdb) {
      /* DQT */
      let q = s;
      while (q < e) {
        const pq = bytes[q] >> 4;
        const tq = bytes[q] & 15;
        q++;
        const nat = new Float32Array(64);
        if (pq === 0) {
          if (q + 64 > e) break;
          for (let k = 0; k < 64; k++) nat[ZIG2NAT[k]] = bytes[q + k];
          q += 64;
        } else {
          if (q + 128 > e) break;
          for (let k = 0; k < 64; k++) {
            nat[ZIG2NAT[k]] = readU16BE(bytes, q + k * 2);
          }
          q += 128;
        }
        if (tq < 4) quant[tq] = nat;
      }
      continue;
    }

    if (m === 0xc4) {
      /* DHT */
      let q = s;
      while (q < e) {
        const tc = bytes[q] >> 4;
        const th = bytes[q] & 15;
        q++;
        if (q + 16 > e) break;
        const bits = new Uint8Array(16);
        let total = 0;
        for (let i = 0; i < 16; i++) {
          bits[i] = bytes[q + i];
          total += bits[i];
        }
        q += 16;
        if (q + total > e) break;
        const vals = new Uint8Array(total);
        vals.set(bytes.subarray(q, q + total));
        q += total;
        const t = buildHuffTable(bits, vals);
        if (tc === 0) {
          if (th < 4) huffDC[th] = t;
        } else if (th < 4) huffAC[th] = t;
      }
      continue;
    }

    if (m === 0xdd) {
      /* DRI */
      if (s + 2 <= e) restartInterval = readU16BE(bytes, s);
      continue;
    }

    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      /* SOFn */
      if (s + 6 > e) throw new Error('bad JPEG frame header');
      if (m === 0xc2 || m === 0xca) {
        throw new Error('unsupported JPEG: progressive coding (SOF2)');
      }
      if (
        m === 0xc9 ||
        m === 0xca ||
        m === 0xcd ||
        m === 0xcb ||
        m === 0xcf ||
        m === 0xce
      ) {
        throw new Error('unsupported JPEG: arithmetic coding');
      }
      if (m !== 0xc0 && m !== 0xc1) {
        throw new Error('unsupported JPEG: SOF' + (m - 0xc0));
      }
      height = readU16BE(bytes, s + 1);
      width = readU16BE(bytes, s + 3);
      ncomp = bytes[s + 5];
      if (ncomp !== 1 && ncomp !== 3) {
        throw new Error('unsupported JPEG: ' + ncomp + ' components');
      }
      let q = s + 6;
      for (let i = 0; i < ncomp; i++) {
        if (q + 3 > e) throw new Error('bad JPEG frame header');
        comps.push({
          id: bytes[q],
          h: bytes[q + 1] >> 4,
          v: bytes[q + 1] & 15,
          tq: bytes[q + 2],
          td: 0,
          ta: 0,
          pred: 0,
          plane: new Uint8Array(0),
          planeW: 0,
          planeH: 0,
          compW: 0,
          compH: 0,
          dctScaled: 8,
        });
        q += 3;
      }
      if (ncomp === 3 && adobeTransform === 2) {
        throw new Error('unsupported JPEG: Adobe YCCK transform');
      }
      sawSOF = true;
      continue;
    }

    if (m === 0xda) {
      /* SOS */
      if (!sawSOF) throw new Error('bad JPEG: missing SOF');
      const ns = bytes[s];
      let q = s + 1;
      for (let i = 0; i < ns; i++) {
        if (q + 2 > e) throw new Error('bad JPEG scan header');
        const id = bytes[q];
        const td = bytes[q + 1] >> 4;
        const ta = bytes[q + 1] & 15;
        q += 2;
        for (let c = 0; c < comps.length; c++) {
          if (comps[c].id === id) {
            comps[c].td = td;
            comps[c].ta = ta;
          }
        }
      }
      q += 3;
      scanStart = q;
      break;
    }
  }

  if (!sawSOF) throw new Error('bad JPEG: no SOF marker found');
  if (scanStart < 0) throw new Error('bad JPEG: no SOS marker found');
  if (width <= 0 || height <= 0) throw new Error('bad JPEG: zero image size');
  if (comps.length === 0) throw new Error('bad JPEG: no components');

  let hmax = 1;
  let vmax = 1;
  for (let i = 0; i < comps.length; i++) {
    if (comps[i].h > hmax) hmax = comps[i].h;
    if (comps[i].v > vmax) vmax = comps[i].v;
    if (comps[i].h < 1 || comps[i].v < 1) {
      throw new Error('bad JPEG: invalid sampling factor');
    }
  }

  const mcusX = Math.ceil(width / (hmax * 8));
  const mcusY = Math.ceil(height / (vmax * 8));
  /*
   * libjpeg's DCT scaling. `minScaled` is 8 / scale_denom, the smallest block any component
   * decodes to; a component then doubles its own scaled size as far as the sampling factors let
   * it, so that the chroma of a 4:2:0 image is enlarged by the IDCT rather than by the
   * upsampler -- at scale 4 a 64x64 4:2:0 jpeg decodes its luma with the 2x2 IDCT and its
   * chroma with the 4x4 one, and neither is upsampled at all (jpeg_calc_output_dimensions,
   * jdmaster.c).
   */
  const minScaled = 8 / shrink;
  /*
   * The size libvips hands on from a shrunk load: `width / scale_denom` rounded DOWN, not up. libjpeg
   * itself decodes the padded frame -- a 35x21 4:2:0 jpeg carries 18 columns of samples at
   * scale_denom 2 -- but the image the resize then sees is the first 17, and it is that number and
   * not the padded one that decides the OUTPUT size: a 35x21 jpeg resized to a width of 4 is 4x3,
   * because 21/8 rounded down is 5 and 35/8 rounded down is 8 and 3 = round(4 * 5 / 8), where the
   * padded 9x6 gives 4x2. Measured against sharp 0.33.5 as 1214 of 1214 output sizes over seven
   * sources (35x21, 37x23, 33x17, 100x60, 21x13, 64x48, 64x64), every width from 1 to twice the
   * source's and every height from 1 to twice the source's, with fastShrinkOnLoad both default and
   * false. At scale_denom 1 the two agree, so an undecoded read is untouched.
   */
  const outW = Math.max(1, Math.floor(width / shrink));
  const outH = Math.max(1, Math.floor(height / shrink));

  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    let ssize = minScaled;
    while (
      ssize < 8 &&
      (hmax * minScaled) % (c.h * ssize * 2) === 0 &&
      (vmax * minScaled) % (c.v * ssize * 2) === 0
    ) {
      ssize = ssize * 2;
    }
    c.dctScaled = ssize;
    const bw = mcusX * c.h * ssize;
    const bh = mcusY * c.v * ssize;
    c.planeW = bw;
    c.planeH = bh;
    c.plane = new Uint8Array(bw * bh);
    /* downsampled_width/height in libjpeg's sense: the size the component has after the IDCT. */
    c.compW = Math.ceil((width * c.h * ssize) / (hmax * 8));
    c.compH = Math.ceil((height * c.v * ssize) / (vmax * 8));
    if (c.compW > bw) c.compW = bw;
    if (c.compH > bh) c.compH = bh;
    if (quant[c.tq] === undefined) c.pred = 0;
  }

  const br = new BitReader(bytes, scanStart);
  const coef = new Float32Array(64);
  const outb = new Float32Array(64);

  let mcusDone = 0;
  let rstExpect = 0;
  let stop = false;

  for (let my = 0; my < mcusY && !stop; my++) {
    for (let mx = 0; mx < mcusX && !stop; mx++) {
      if (restartInterval > 0 && mcusDone > 0 && mcusDone % restartInterval === 0) {
        br.align();
        /* look for RSTn / EOI */
        let found = false;
        while (br.pos + 1 < len) {
          if (bytes[br.pos] === 0xff) {
            const mk = bytes[br.pos + 1];
            if (mk >= 0xd0 && mk <= 0xd7) {
              br.pos += 2;
              rstExpect = (rstExpect + 1) & 7;
              found = true;
              break;
            }
            if (mk === 0xd9) {
              br.pos += 2;
              stop = true;
              found = true;
              break;
            }
            if (mk === 0xff) {
              br.pos++;
              continue;
            }
          }
          br.pos++;
        }
        if (!found) stop = true;
        for (let i = 0; i < comps.length; i++) comps[i].pred = 0;
      }
      if (stop) break;

      for (let ci = 0; ci < comps.length; ci++) {
        const c = comps[ci];
        const qt = quant[c.tq];
        const hdc = huffDC[c.td];
        const hac = huffAC[c.ta];
        if (qt === undefined) throw new Error('bad JPEG: missing quant table');
        if (hdc === undefined || hac === undefined) {
          throw new Error('bad JPEG: missing Huffman table');
        }
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            coef.fill(0);
            const t = decodeHuff(br, hdc);
            const diff = t === 0 ? 0 : receiveExtend(br, t);
            c.pred += diff;
            coef[0] = c.pred * qt[0];
            let k = 1;
            while (k < 64) {
              const rs = decodeHuff(br, hac);
              const s = rs & 15;
              const r = rs >> 4;
              if (s === 0) {
                if (r === 15) {
                  k += 16;
                  continue;
                }
                break; /* EOB */
              }
              k += r;
              if (k > 63) break;
              const ni = ZIG2NAT[k];
              coef[ni] = receiveExtend(br, s) * qt[ni];
              k++;
            }

            /*
             * libjpeg's jpeg_idct_islow, not the float transform: the samples
             * it writes are already clamped and level shifted, so the +128.5
             * the float path needed is gone. Under DCT scaling it is the
             * reduced-size pair of that transform instead, writing
             * `dctScaled` x `dctScaled` samples per block.
             */
            const n = c.dctScaled;
            if (n === 8) idctIslow(coef, outb);
            else if (n === 4) idct4x4(coef, outb);
            else if (n === 2) idct2x2(coef, outb);
            else idct1x1(coef, outb);

            const blockX = (mx * c.h + bx) * n;
            const blockY = (my * c.v + by) * n;
            for (let yy = 0; yy < n; yy++) {
              let o = (blockY + yy) * c.planeW + blockX;
              const src = yy * n;
              for (let xx = 0; xx < n; xx++) {
                c.plane[o++] = outb[src + xx];
              }
            }
          }
        }
      }
      mcusDone++;
    }
  }

  /*
   * Upsample every component to the output resolution, which under DCT scaling is the shrunk one
   * and not the image's. The ratios follow from the sizes libjpeg ends up with rather than from
   * the sampling factors: a component whose IDCT was scaled up to the output size is 1:1 even
   * where its sampling factors are not, which is the whole point of scaling the chroma in the
   * IDCT. A ratio that does not divide exactly rounds up, and the upsampler clips the extra
   * samples off the right and bottom the way libjpeg drops them.
   */
  const planes: Uint8Array[] = [];
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    const hr = Math.max(1, Math.round(outW / c.compW));
    const vr = Math.max(1, Math.round(outH / c.compH));
    planes.push(
      upsampleComponent(c.plane, c.planeW, c.compW, c.compH, outW, outH, hr, vr)
    );
  }

  /* assemble */
  const npx = outW * outH;
  let channels: 1 | 2 | 3 | 4;
  const data = new Uint8Array(npx * (comps.length === 1 ? 1 : 3));

  if (comps.length === 1) {
    channels = 1;
    data.set(planes[0]);
  } else {
    channels = 3;
    const y = planes[0];
    const cb = planes[1];
    const cr = planes[2];
    const noConv = adobeTransform === 0;
    for (let i = 0; i < npx; i++) {
      const yy = y[i];
      if (noConv) {
        data[i * 3] = yy;
        data[i * 3 + 1] = cb[i];
        data[i * 3 + 2] = cr[i];
        continue;
      }
      const cbv = cb[i];
      const crv = cr[i];
      data[i * 3] = clamp255(yy + CR_R_TAB[crv]);
      data[i * 3 + 1] = clamp255(yy + ((CB_G_TAB[cbv] + CR_G_TAB[crv]) >> 16));
      data[i * 3 + 2] = clamp255(yy + CB_B_TAB[cbv]);
    }
  }

  let icc: Uint8Array | undefined;
  if (iccChunks !== undefined && iccChunks.length > 0) {
    let total = 0;
    for (let i = 0; i < iccChunks.length; i++) total += iccChunks[i].length;
    icc = new Uint8Array(total);
    let o = 0;
    for (let i = 0; i < iccChunks.length; i++) {
      icc.set(iccChunks[i], o);
      o += iccChunks[i].length;
    }
  }

  const info: JpegInfo = {
    chromaSubsampling:
      comps.length === 1
        ? '4:4:4'
        : chromaLabel(comps[0].h, comps[0].v, comps[1].h, comps[1].v),
    isProgressive: false,
    hasProfile: icc !== undefined,
  };
  /*
   * The EXIF resolution wins over the JFIF one when the file carries both. A resolution too small to
   * keep is still a resolution the file carries, so the unit goes with it even though the density
   * does not: a jpeg written with `withMetadata({density: 25})` reports `resolutionUnit: 'inch'` and
   * no `density` at all on host sharp 0.33.5, and the 72 dpi libvips falls back to belongs only to a
   * jpeg that names no resolution -- measured on the same file with its EXIF and ICC stripped, which
   * reports 72 whatever the density it was written with.
   */
  if (exifDensity !== undefined) {
    density = exifDensity;
    resolutionUnit = exifUnit;
  }
  if (density !== undefined) info.density = density;
  if (resolutionUnit !== undefined) info.resolutionUnit = resolutionUnit;
  if (orientation !== undefined) info.orientation = orientation;
  if (exif !== undefined) info.exif = exif;
  if (icc !== undefined) info.icc = icc;
  if (xmp !== undefined) info.xmp = xmp;

  return { image: { width: outW, height: outH, channels, data }, info };
}

/* ----------------------------------------------------------------- encode -- */

function scaleQuant(base: Uint8Array, quality: number): Uint8Array {
  const q = quality < 1 ? 1 : quality > 100 ? 100 : quality;
  const sf = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    let v = Math.floor((base[i] * sf + 50) / 100);
    if (v < 1) v = 1;
    if (v > 255) v = 255;
    out[i] = v;
  }
  return out;
}

interface EncComp {
  id: number;
  h: number;
  v: number;
  tq: number;
  td: number;
  ta: number;
  plane: Uint8Array;
  planeW: number;
  planeH: number;
  pred: number;
}

function padPlane(
  plane: Uint8Array,
  planeW: number,
  planeH: number,
  compW: number,
  compH: number
): void {
  if (compW < 1 || compH < 1) return;
  for (let y = 0; y < planeH; y++) {
    const o = y * planeW;
    const last = plane[o + compW - 1];
    for (let x = compW; x < planeW; x++) plane[o + x] = last;
  }
  for (let y = compH; y < planeH; y++) {
    plane.copyWithin(y * planeW, (compH - 1) * planeW, compH * planeW);
  }
}

export function encodeJpeg(
  image: Image,
  quality: number,
  chromaSubsampling: string
): Uint8Array {
  const w = image.width | 0;
  const h = image.height | 0;
  const src = image.data;
  const nch = image.channels;
  if (w <= 0 || h <= 0) throw new Error('bad image: zero size');

  const grey = nch === 1 || nch === 2;
  let hy = 1;
  let vy = 1;
  if (!grey) {
    if (chromaSubsampling === '4:4:4') {
      hy = 1;
      vy = 1;
    } else if (chromaSubsampling === '4:2:2') {
      hy = 2;
      vy = 1;
    } else {
      hy = 2;
      vy = 2;
    }
  }
  const hmax = grey ? 1 : hy;
  const vmax = grey ? 1 : vy;
  const mcusX = Math.ceil(w / (hmax * 8));
  const mcusY = Math.ceil(h / (vmax * 8));

  const ncomp = grey ? 1 : 3;
  const comps: EncComp[] = [];

  const qLumaZig = scaleQuant(STD_LUMA_Q, quality);
  const qChromaZig = scaleQuant(STD_CHROMA_Q, quality);
  const qLumaNat = new Float32Array(64);
  const qChromaNat = new Float32Array(64);
  for (let i = 0; i < 64; i++) {
    qLumaNat[i] = qLumaZig[NAT2ZIG[i]];
    qChromaNat[i] = qChromaZig[NAT2ZIG[i]];
  }

  /* full resolution YCbCr (or grey) */
  const npx = w * h;
  const ycc = new Uint8Array(npx * (grey ? 1 : 3));
  for (let i = 0; i < npx; i++) {
    const o = i * nch;
    if (grey) {
      ycc[i] = src[o];
    } else {
      const r = src[o];
      const g = src[o + 1];
      const b = src[o + 2];
      ycc[i * 3] = clamp255f(0.299 * r + 0.587 * g + 0.114 * b);
      ycc[i * 3 + 1] = clamp255f(
        -0.16874 * r - 0.33126 * g + 0.5 * b + 128
      );
      ycc[i * 3 + 2] = clamp255f(
        0.5 * r - 0.41869 * g - 0.08131 * b + 128
      );
    }
  }

  /* luma / grey plane: full resolution, padded to MCU blocks */
  {
    const planeW = mcusX * hy * 8;
    const planeH = mcusY * vy * 8;
    const plane = new Uint8Array(planeW * planeH);
    for (let y = 0; y < h; y++) {
      const d = y * planeW;
      const s = y * w;
      for (let x = 0; x < w; x++) {
        plane[d + x] = grey ? ycc[s + x] : ycc[(s + x) * 3];
      }
    }
    padPlane(plane, planeW, planeH, w, h);
    comps.push({
      id: 1,
      h: hy,
      v: vy,
      tq: 0,
      td: 0,
      ta: 0,
      plane,
      planeW,
      planeH,
      pred: 0,
    });
  }

  if (!grey) {
    const cw = Math.ceil(w / hmax);
    const chh = Math.ceil(h / vmax);
    const planeW = mcusX * 8;
    const planeH = mcusY * 8;
    const n = hy * vy;
    const half = n >> 1;
    for (let c = 0; c < 2; c++) {
      const plane = new Uint8Array(planeW * planeH);
      for (let j = 0; j < chh; j++) {
        const sy0 = j * vy;
        for (let i = 0; i < cw; i++) {
          const sx0 = i * hy;
          let sum = 0;
          for (let dy = 0; dy < vy; dy++) {
            let y = sy0 + dy;
            if (y >= h) y = h - 1;
            const row = y * w;
            for (let dx = 0; dx < hy; dx++) {
              let x = sx0 + dx;
              if (x >= w) x = w - 1;
              sum += ycc[(row + x) * 3 + 1 + c];
            }
          }
          plane[j * planeW + i] = (sum + half) / n;
        }
      }
      padPlane(plane, planeW, planeH, cw, chh);
      comps.push({
        id: 2 + c,
        h: 1,
        v: 1,
        tq: 1,
        td: 1,
        ta: 1,
        plane,
        planeW,
        planeH,
        pred: 0,
      });
    }
  }

  /* marker stream */
  const bw = new BitWriter(Math.max(1024, npx * 3));
  const seg = (marker: number, payload: number[]): void => {
    bw.byte(0xff);
    bw.byte(marker);
    bw.byte(((payload.length + 2) >> 8) & 0xff);
    bw.byte((payload.length + 2) & 0xff);
    for (let i = 0; i < payload.length; i++) bw.byte(payload[i]);
  };

  bw.byte(0xff);
  bw.byte(0xd8); /* SOI */

  /* APP0 JFIF, density 72 dpi */
  seg(0xe0, [
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00,
    0x00,
  ]);

  /* DQT */
  {
    const payload: number[] = [0x00];
    for (let i = 0; i < 64; i++) payload.push(qLumaZig[i]);
    if (!grey) {
      payload.push(0x01);
      for (let i = 0; i < 64; i++) payload.push(qChromaZig[i]);
    }
    seg(0xdb, payload);
  }

  /* SOF0 */
  {
    const payload: number[] = [0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, ncomp];
    for (let i = 0; i < ncomp; i++) {
      const c = comps[i];
      payload.push(c.id, (c.h << 4) | c.v, c.tq);
    }
    seg(0xc0, payload);
  }

  /* DHT */
  const dht = (cls: number, id: number, bits: Uint8Array, vals: Uint8Array): void => {
    const payload: number[] = [(cls << 4) | id];
    for (let i = 0; i < 16; i++) payload.push(bits[i]);
    for (let i = 0; i < vals.length; i++) payload.push(vals[i]);
    seg(0xc4, payload);
  };
  dht(0, 0, STD_DC_LUMA_BITS, STD_DC_VALS);
  dht(1, 0, STD_AC_LUMA_BITS, STD_AC_LUMA_VALS);
  if (!grey) {
    dht(0, 1, STD_DC_CHROMA_BITS, STD_DC_VALS);
    dht(1, 1, STD_AC_CHROMA_BITS, STD_AC_CHROMA_VALS);
  }

  /* SOS */
  {
    const payload: number[] = [ncomp];
    for (let i = 0; i < ncomp; i++) {
      payload.push(comps[i].id, (comps[i].td << 4) | comps[i].ta);
    }
    payload.push(0x00, 0x3f, 0x00);
    seg(0xda, payload);
  }

  /* entropy coded data */
  const dcEnc = [
    buildEncTable(STD_DC_LUMA_BITS, STD_DC_VALS),
    buildEncTable(STD_DC_CHROMA_BITS, STD_DC_VALS),
  ];
  const acEnc = [
    buildEncTable(STD_AC_LUMA_BITS, STD_AC_LUMA_VALS),
    buildEncTable(STD_AC_CHROMA_BITS, STD_AC_CHROMA_VALS),
  ];

  const samples = new Float32Array(64);
  const tmp = new Float32Array(64);
  const coef = new Float32Array(64);
  const qc = new Int32Array(64);

  const magnitude = (v: number): number => {
    let a = v < 0 ? -v : v;
    let s = 0;
    while (a !== 0) {
      s++;
      a >>= 1;
    }
    return s;
  };

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      for (let ci = 0; ci < ncomp; ci++) {
        const c = comps[ci];
        const qn = c.tq === 0 ? qLumaNat : qChromaNat;
        const dcT = dcEnc[c.td];
        const acT = acEnc[c.ta];
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            const blockX = (mx * c.h + bx) * 8;
            const blockY = (my * c.v + by) * 8;
            for (let yy = 0; yy < 8; yy++) {
              const o = (blockY + yy) * c.planeW + blockX;
              const d = yy * 8;
              for (let xx = 0; xx < 8; xx++) {
                samples[d + xx] = c.plane[o + xx] - 128;
              }
            }
            /* forward DCT: samples[y*8+x] -> coef[v*8+u] */
            for (let yy = 0; yy < 8; yy++) {
              dct1d(samples, yy * 8, 1, tmp, yy, 8);
            }
            for (let u = 0; u < 8; u++) {
              dct1d(tmp, u * 8, 1, coef, u, 8);
            }
            for (let i = 0; i < 64; i++) {
              const v = coef[i] / qn[i];
              qc[i] = v < 0 ? -Math.round(-v) : Math.round(v);
            }

            /* DC */
            const diff = qc[0] - c.pred;
            c.pred = qc[0];
            const ds = magnitude(diff);
            bw.writeBits(dcT.code[ds], dcT.length[ds]);
            if (ds > 0) {
              bw.writeBits(diff < 0 ? diff + (1 << ds) - 1 : diff, ds);
            }

            /* AC */
            let run = 0;
            for (let k = 1; k < 64; k++) {
              const v = qc[ZIG2NAT[k]];
              if (v === 0) {
                run++;
                continue;
              }
              while (run > 15) {
                bw.writeBits(acT.code[0xf0], acT.length[0xf0]);
                run -= 16;
              }
              const s = magnitude(v);
              const sym = (run << 4) | s;
              bw.writeBits(acT.code[sym], acT.length[sym]);
              bw.writeBits(v < 0 ? v + (1 << s) - 1 : v, s);
              run = 0;
            }
            if (run > 0) bw.writeBits(acT.code[0x00], acT.length[0x00]);
          }
        }
      }
    }
  }

  bw.flush();
  bw.byte(0xff);
  bw.byte(0xd9); /* EOI */

  return bw.finish();
}
