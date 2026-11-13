import Foundation

// Two claps wake Roamies, like "Hey Roamies": two short, sharp sounds of about the same loudness, 0.15 to 0.8 s apart,
// with quiet around them. Speech and music rise too slowly or last too long; applause and typing bring too many sharp
// sounds; a far-off TV is too quiet next to the claps. It's fed the mic's own samples (before the quiet-mic boost) on
// the audio thread, in 5 ms blocks. Known limit: any two isolated, equally loud bangs count (a double knock).
// Plain Swift only, so it matches the prototype it was tuned on step for step; `--test-claps` checks it.
final class ClapDetector {
    static let blockSecs = 0.005
    static let minLevel = 0.03     // block RMS a clap must reach (about -30 dBFS)...
    static let overRoom = 20.0     // ...and this many times the room's level (26 dB)
    static let jump = 6.0          // its rise from the blocks before: a sharp attack
    static let attack = 0.015      // peak within this of the onset
    static let decay = 0.1         // and down to a quarter of the peak within this
    static let tail = 0.3          // after a clap, its echo isn't counted as other sound
    static let minGap = 0.15, maxGap = 0.8 // between the two claps' onsets
    static let quietBefore = 0.3   // no other sound near the claps' loudness this long before the first
    static let waitAfter = 0.55    // and no third clap this long after the second
    static let match = 4.0         // the two peaks within 12 dB of each other
    static let soft = 4.0          // sound this far under the clap level is noted as other sound...
    static let relative = 10.0     // ...and breaks the quiet when within 20 dB of the softer clap
    static let lead = 0.011        // a clap's own first sliver, in the block before its onset, isn't other sound

    private struct Event { var start: Double; var peak: Double; var peakAt: Double }
    private var rate = 0.0, size = 1, n = 0, sum = 0.0, t = 0.0
    private var room = 0.0, prev = 0.0, prev2 = 0.0
    private var claps: [(at: Double, peak: Double)] = []
    private var event: Event?
    private var tailUntil = -1.0
    private var strays: [(t: Double, env: Double)] = []

    /// Mono samples in; how many double claps finished in them (normally 0 or 1).
    func feed(_ samples: UnsafePointer<Float>, count: Int, rate r: Double) -> Int {
        guard r > 0 else { return 0 }
        if r != rate { rate = r; size = max(1, Int((r * Self.blockSecs).rounded())); n = 0; sum = 0 }
        var fired = 0
        for i in 0 ..< count {
            let v = Double(samples[i])
            sum += v * v
            n += 1
            if n < size { continue }
            let env = (sum / Double(n)).squareRoot()
            n = 0; sum = 0
            t += Double(size) / rate
            if step(env, t) { fired += 1 }
        }
        return fired
    }

    private func step(_ env: Double, _ t: Double) -> Bool {
        if room == 0 { room = max(env, 1e-6) }
        let on = max(room * Self.overRoom, Self.minLevel)
        if var e = event {
            if env > e.peak { e.peak = env; e.peakAt = t }
            if e.peakAt - e.start > Self.attack { noise(t, e.peak) } // slow rise: speech, music
            else if env < e.peak / 4 { // died away fast: a clap
                event = nil
                claps.append((at: e.start, peak: e.peak))
                tailUntil = t + Self.tail
            } else if t - e.start > Self.decay { noise(t, e.peak) } // went on too long
            else { event = e }
        } else if env > on && env > min(prev, prev2) * Self.jump { // two blocks back: an onset can straddle a block edge
            event = Event(start: t, peak: env, peakAt: t)
        } else if env > on / Self.soft && t > tailUntil {
            strays.append((t: t, env: env))
        }
        if event == nil && t > tailUntil { room = env < room ? max(env, 1e-6) : room * 1.002 }
        prev2 = prev; prev = env

        if claps.count >= 3 { noise(t, .infinity); return false }
        if claps.count == 2 && t >= claps[1].at + Self.waitAfter && event == nil {
            let a = claps[0], b = claps[1], gap = b.at - a.at
            let ratio = max(a.peak, b.peak) / min(a.peak, b.peak), softest = min(a.peak, b.peak) / Self.relative
            claps.removeAll()
            let quiet = strays.allSatisfy { s in
                s.t < a.at - Self.quietBefore || s.env < softest
                    || (s.t >= a.at - Self.lead && s.t < a.at) || (s.t >= b.at - Self.lead && s.t < b.at)
            }
            return gap >= Self.minGap && gap <= Self.maxGap && ratio <= Self.match && quiet
        }
        if claps.count == 1 && t > claps[0].at + Self.maxGap + 0.1 { claps.removeAll() }
        while let s = strays.first, s.t < t - 2 { strays.removeFirst() }
        return false
    }

    private func noise(_ t: Double, _ env: Double) { event = nil; claps.removeAll(); strays.append((t: t, env: env)) }
}

// Made-up sounds for `--test-claps`: room hiss, claps (with an optional echo), speech, key taps. Seeded, so every run
// hears the same thing.
final class ClapScene {
    var x: [Float]
    let rate: Double
    private var seed: UInt32

    init(rate: Double, secs: Double, seed: UInt32 = 1) {
        self.rate = rate; self.seed = seed
        x = [Float](repeating: 0, count: Int((rate * secs).rounded()))
        for i in 0 ..< x.count { x[i] = Float(rnd() * 0.002) } // about -57 dBFS
    }

    func rnd() -> Double { seed = seed &* 1664525 &+ 1013904223; return Double(seed) / 4294967296 * 2 - 1 }

    func clap(_ at: Double, _ amp: Double = 0.6, reverb: Double = 0) {
        let i0 = Int((at * rate).rounded())
        var k = 0
        while Double(k) < rate * 0.6 && i0 + k < x.count {
            let tt = Double(k) / rate, rise = min(1, tt / 0.0005)
            x[i0 + k] += Float(rnd() * amp * (rise * exp(-tt / 0.006) + reverb * exp(-tt / 0.15)))
            k += 1
        }
    }

    func speech(_ from: Double, _ to: Double, _ amp: Double = 0.15) {
        var i = Int((from * rate).rounded())
        while i < x.count && Double(i) < to * rate {
            let tt = Double(i) / rate, syl = (tt - from).truncatingRemainder(dividingBy: 0.22)
            let env = min(1, syl / 0.04) * min(1, (0.22 - syl) / 0.05)
            let f0 = 140 + 30 * sin(tt * 3)
            var v = 0.0
            for h in 1 ... 8 { v += sin(2 * Double.pi * f0 * Double(h) * tt) / Double(h) }
            x[i] += Float(amp * env * (0.5 * v + 0.15 * rnd()))
            i += 1
        }
    }

    func tap(_ at: Double, _ amp: Double = 0.25) { // a key or a knock: short and sharp
        let i0 = Int((at * rate).rounded())
        var k = 0
        while Double(k) < rate * 0.03 && i0 + k < x.count {
            x[i0 + k] += Float(rnd() * amp * exp(-(Double(k) / rate) / 0.002))
            k += 1
        }
    }

    /// Double claps heard, fed in mic-sized chunks.
    func doubleClaps(chunk: Int = 1024) -> Int {
        let d = ClapDetector()
        var found = 0
        x.withUnsafeBufferPointer { p in
            guard let base = p.baseAddress else { return }
            var i = 0
            while i < p.count { found += d.feed(base + i, count: min(chunk, p.count - i), rate: rate); i += chunk }
        }
        return found
    }
}
