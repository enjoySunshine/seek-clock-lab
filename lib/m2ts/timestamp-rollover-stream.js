/**
 * mux.js
 *
 * Copyright (c) Brightcove
 *
 *
 * Accepts program elementary stream (PES) data events and corrects
 * decode and presentation time stamps to account for a rollover
 * of the 33 bit value.
 */

'use strict';

var Stream = require('../utils/stream');

var MAX_TS = 8589934592;

var RO_THRESH = 4294967296;

// Thresholds on how far short of a full circle a move may fall and still
// count as crossing a seam. The two directions use different bounds because
// the counter is monotonic:
//
//  - A drop is always a rollover, but a small in-cycle backwards nudge must
//    not be mistaken for one. A real rollover spans more than half the circle
//    (RO_THRESH), while a nudge spans only a few ticks, so drops use the
//    half-circle bound.
//  - A rise is normally forward motion, including arbitrarily large seeks.
//    Only a rise that wraps almost a full circle (a backwards scrub across
//    zero) is folded, and those land within a quarter circle of the seam. A
//    forward seek such as 1000 -> 5000001000 falls ~0.42 circle short of a
//    full circle - outside this tighter bound - and is therefore kept on the
//    wire instead of being folded into a negative timestamp.
var DROP_ROLLOVER_GUARD = RO_THRESH;
var RISE_SCRUB_GUARD = MAX_TS / 4;

var TYPE_SHARED = 'shared';

/**
 * Unwrap a 33-bit timestamp onto a continuous timeline relative to a
 * reference timestamp. The reference may itself already be unwrapped and may
 * be negative (after a backwards scrub that crossed the zero point).
 *
 * Let d be the stored displacement (value - reference) and g = 2^33 - |d| the
 * number of ticks by which the move falls short of completing a full circle.
 *
 *  1. d < 0 (stored value dropped) and g < DROP_ROLLOVER_GUARD: the
 *     free-running counter physically fell through 2^33 and restarted near 0
 *     (a rollover) -> continue in the next cycle by adding MAX_TS.
 *
 *  2. d > 0 (stored value rose) and g < RISE_SCRUB_GUARD: the value wrapped
 *     almost a full circle to just below 2^33, i.e. a backwards scrub across
 *     the zero point -> drop into the previous cycle by subtracting MAX_TS.
 *     The result may legitimately be negative.
 *
 *  3. In every other case the move is genuine motion in the reference's
 *     cycle: forward steps and seeks, and small backwards nudges that do not
 *     cross a seam, all keep their wire position.
 *
 * At most one whole circle is ever added or removed.
 */
var handleRollover = function(value, reference) {
  var valueMod = value % MAX_TS;
  var refMod = reference % MAX_TS;
  var refCycles = Math.floor(reference / MAX_TS);
  var displacement = valueMod - refMod;
  var gapToFullCircle;

  if (displacement === 0) {
    return reference;
  }

  gapToFullCircle = MAX_TS - Math.abs(displacement);

  if (displacement < 0 && gapToFullCircle < DROP_ROLLOVER_GUARD) {
    // Dropped through the 2^33 seam: real rollover into the next cycle.
    return valueMod + (refCycles + 1) * MAX_TS;
  }

  if (displacement > 0 && gapToFullCircle < RISE_SCRUB_GUARD) {
    // Rose through the zero seam: backwards scrub into the previous cycle.
    return valueMod + (refCycles - 1) * MAX_TS;
  }

  // Genuine motion (step, seek, or small nudge) within the reference's cycle.
  return valueMod + refCycles * MAX_TS;
};

var TimestampRolloverStream = function(type) {
  var lastDTS, referenceDTS;

  TimestampRolloverStream.prototype.init.call(this);

  // The "shared" type is used in cases where a stream will contain muxed
  // video and audio. We could use `undefined` here, but having a string
  // makes debugging a little clearer.
  this.type_ = type || TYPE_SHARED;

  this.push = function(data) {
    /**
     * Rollover stream expects data from elementary stream.
     * Elementary stream can push forward 2 types of data
     * - Parsed Video/Audio/Timed-metadata PES (packetized elementary stream) packets
     * - Tracks metadata from PMT (Program Map Table)
     * Rollover stream expects pts/dts info to be available, since it stores lastDTS
     * We should ignore non-PES packets since they may override lastDTS to undefined.
     * lastDTS is important to signal the next segments
     * about rollover from the previous segments.
     */
    if (data.type === 'metadata') {
      this.trigger('data', data);
      return;
    }

    // Any "shared" rollover streams will accept _all_ data. Otherwise,
    // streams will only accept data that matches their type.
    if (this.type_ !== TYPE_SHARED && data.type !== this.type_) {
      return;
    }

    if (referenceDTS === undefined) {
      referenceDTS = data.dts;
    }

    data.dts = handleRollover(data.dts, referenceDTS);
    data.pts = handleRollover(data.pts, referenceDTS);

    lastDTS = data.dts;

    this.trigger('data', data);
  };

  this.flush = function() {
    referenceDTS = lastDTS;
    this.trigger('done');
  };

  this.endTimeline = function() {
    this.flush();
    this.trigger('endedtimeline');
  };

  this.discontinuity = function() {
    referenceDTS = void 0;
    lastDTS = void 0;
  };

  this.reset = function() {
    this.discontinuity();
    this.trigger('reset');
  };
};

TimestampRolloverStream.prototype = new Stream();

module.exports = {
  TimestampRolloverStream: TimestampRolloverStream,
  handleRollover: handleRollover
};
