// Voice helper for Roamies (macOS). Watches ⌃⌥, captures the mic and transcribes on-device with
// Apple's SpeechAnalyzer (macOS 26+, works with Siri and Dictation off; SFSpeechRecognizer before that).
// A session never ends while ⌃⌥ is held: it ends on release (push-to-talk), or for hands-free
// (quick tap) on a pause or the next press-and-release. Hold ⌃⌥ = push-to-talk (release sends). Quick tap = hands-free
// (ends on a pause or another tap). JSON lines on stdout; exits when stdin closes.
// Modifier state is read with CGEventSource, which needs no Input Monitoring permission.
// While ⌃⌥ is held, moving the cursor draws on the screen (ink.swift); the marked area goes out with what was said.
// While listening, a small voice-bar pill rides beside the cursor (wave.swift) instead of a transcript bubble.
// With the wake word on, it also listens quietly for "Hey Roamies" and starts a hands-free take on hearing it; with
// clap to wake on, two claps do the same (clap.swift).
import AVFoundation
import AppKit
import CoreAudio
import CoreGraphics
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

/// Whether a click does something that changes what's on screen: a button, link, tab, menu item, pop-up or search
/// field, or a double-click that opens a row or icon in a list. Roles run from the clicked element up to its window.
enum ClickTarget {
    static let acting: Set<String> = ["AXButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXMenuButton", "AXPopUpButton", "AXComboBox",
                                      "AXSearchField", "AXRadioButton", "AXTab", "AXDisclosureTriangle", "AXIncrementor", "AXColorWell",
                                      "AXDockItem", "AXSegmentedControl"]
    // Where climbing stops: a click on the empty part of one of these does nothing, but a double-click in a list opens.
    static let containers: Set<String> = ["AXWebArea", "AXScrollArea", "AXSplitGroup", "AXApplication", "AXLayoutArea", "AXWindow",
                                          "AXList", "AXTable", "AXOutline", "AXBrowser"]
    static let opensOnDouble: Set<String> = ["AXList", "AXTable", "AXOutline", "AXBrowser"]
    static func acts(roles: [String], count: Int) -> Bool {
        for r in roles {
            if acting.contains(r) { return true }
            if containers.contains(r) { return count >= 2 && opensOnDouble.contains(r) }
        }
        return false
    }
    /// The roles under a point and its app (empty when it can't be read); nil for Roamies' own windows.
    static func at(_ p: CGPoint) -> (roles: [String], app: String)? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.25)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &hit) == .success, var e = hit else { return ([], "") }
        var pid: pid_t = 0
        AXUIElementGetPid(e, &pid)
        if pid == getpid() || pid == getppid() { return nil }
        var roles: [String] = []
        for _ in 0 ..< 10 {
            var v: CFTypeRef?
            if AXUIElementCopyAttributeValue(e, kAXRoleAttribute as CFString, &v) == .success, let r = v as? String { roles.append(r) }
            var up: CFTypeRef?
            guard AXUIElementCopyAttributeValue(e, kAXParentAttribute as CFString, &up) == .success, let u = up, CFGetTypeID(u) == AXUIElementGetTypeID() else { break }
            e = u as! AXUIElement
        }
        return (roles, NSRunningApplication(processIdentifier: pid)?.localizedName ?? "")
    }
}

func log(_ s: String) {
    FileHandle.standardError.write(Data("[voice] \(s)\n".utf8))
}

// Wake lines carry the time, so a missed "Hey Roamies" can be matched to when it was said.
private let clock: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm:ss"; return f }()
func wakeLog(_ s: String) { log("wake \(clock.string(from: Date())): \(s)") }

let dryRun = ProcessInfo.processInfo.environment["ROAMIES_VOICE_DRYRUN"] == "1"

// --test-live <wav>: the recording stands in for the room, played in real time to whatever is listening (wake or a
// take), with the wake word on and nothing muted. Runs the real paths end to end; exits 15 s after the recording ends.
enum LiveTest {
    static let url: URL? = {
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: "--test-live"), i + 1 < a.count else { return nil }
        return URL(fileURLWithPath: a[i + 1])
    }()
    static var sink: ((AVAudioPCMBuffer) -> Void)?
    private static var timer: DispatchSourceTimer?

    static func start() {
        guard let url, let file = try? AVAudioFile(forReading: url),
              let all = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: all)) != nil else { log("test-live: can't read the recording"); exit(2) }
        let fmt = all.format, chunk: AVAudioFrameCount = 1024
        var pos: AVAudioFrameCount = 0, silent = 0
        let t = DispatchSource.makeTimerSource(queue: .global())
        t.schedule(deadline: .now(), repeating: Double(chunk) / fmt.sampleRate)
        t.setEventHandler {
            guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: chunk) else { return }
            buf.frameLength = chunk
            for c in 0 ..< Int(fmt.channelCount) {
                let dst = buf.floatChannelData![c]
                for k in 0 ..< Int(chunk) { dst[k] = pos + AVAudioFrameCount(k) < all.frameLength ? all.floatChannelData![c][Int(pos) + k] : 0 }
            }
            if pos < all.frameLength { pos += chunk; if pos >= all.frameLength { log("test-live: recording ended") } }
            else { silent += 1; if Double(silent * Int(chunk)) / fmt.sampleRate > 15 { DispatchQueue.main.async { exit(0) } } }
            DispatchQueue.main.async { sink?(buf) }
        }
        t.resume()
        timer = t
    }
}
func uptime() -> Double { ProcessInfo.processInfo.systemUptime }

// One recognition session. Callbacks always arrive on the main queue.
protocol Recognizer: AnyObject {
    func append(_ buffer: AVAudioPCMBuffer)
    func end()
    func cancel()
}
struct RecognizerCallbacks {
    let onText: (String) -> Void
    let onDone: () -> Void
    let onError: (Error) -> Void
}

// Locale.current is limited to the bundle's localizations (none ship), so it is always English:
// follow the user's own language list instead, which also honours a per-app language in System Settings.
func speechLocaleCandidates() -> [Locale] {
    Locale.preferredLanguages.map { Locale(identifier: $0) } + [Locale.current, Locale(identifier: "en-US")]
}

// The older recogniser wants an exact supported locale: take the first of the user's languages it has,
// in that language's main region when the user's region isn't offered (en-BR → en-US).
func legacySpeechLocale() -> Locale? {
    let supported = SFSpeechRecognizer.supportedLocales().sorted { $0.identifier < $1.identifier }
    func key(_ id: String) -> String { id.replacingOccurrences(of: "-", with: "_").lowercased() }
    for want in speechLocaleCandidates() {
        if let hit = supported.first(where: { key($0.identifier) == key(want.identifier) }) { return hit }
        let lang = key(want.identifier).split(separator: "_").first.map(String.init) ?? ""
        let same = supported.filter { key($0.identifier).split(separator: "_").first.map(String.init) == lang }
        if same.isEmpty { continue }
        if #available(macOS 13, *), let region = Locale.Language(identifier: lang).maximalIdentifier.split(separator: "-").last,
           let main = same.first(where: { key($0.identifier) == "\(lang)_\(region.lowercased())" }) { return main }
        return same.first
    }
    return nil
}

// macOS 26+: SpeechAnalyzer + SpeechTranscriber. Model assets are shared system-wide and
// downloaded on first use; the locale and audio format are resolved once and reused.
@available(macOS 26, *)
final class AnalyzerRecognizer: Recognizer {
    private static var prepared: Task<(Locale, AVAudioFormat?), Error>?
    static func prepare() -> Task<(Locale, AVAudioFormat?), Error> {
        if let p = prepared { return p }
        let t = Task { () throws -> (Locale, AVAudioFormat?) in
            var locale: Locale?
            for want in speechLocaleCandidates() where locale == nil {
                locale = await SpeechTranscriber.supportedLocale(equivalentTo: want)
            }
            let resolved = locale ?? Locale(identifier: "en-US")
            let probe = SpeechTranscriber(locale: resolved, preset: .progressiveTranscription)
            if let req = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
                log("downloading speech model for \(resolved.identifier)")
                try await req.downloadAndInstall()
            }
            let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [probe])
            log("speech analyzer ready: \(resolved.identifier) \(format.map { "\($0.sampleRate)Hz" } ?? "native")")
            return (resolved, format)
        }
        prepared = t
        return t
    }

    private let raw: AsyncStream<AVAudioPCMBuffer>.Continuation
    private var work: Task<Void, Never>?
    private var finalized = "", volatile = ""

    init(_ cb: RecognizerCallbacks) {
        let (stream, cont) = AsyncStream<AVAudioPCMBuffer>.makeStream()
        raw = cont
        work = Task { [weak self] in
            do {
                let (locale, format) = try await Self.prepare().value
                let tr = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
                let analyzer = SpeechAnalyzer(modules: [tr])
                // Lean toward the app's names, as contextualStrings does for the older recogniser ("Hey Roamies").
                let context = AnalysisContext()
                context.contextualStrings[.general] = WakeWord.hints
                try? await analyzer.setContext(context)
                var converter: AVAudioConverter?
                let inputs = AsyncStream<AnalyzerInput> { out in
                    Task {
                        for await buf in stream {
                            if let format, buf.format != format {
                                if converter == nil || converter?.inputFormat != buf.format { converter = AVAudioConverter(from: buf.format, to: format) }
                                if let c = converter, let conv = Self.convert(buf, with: c, to: format) { out.yield(AnalyzerInput(buffer: conv)) }
                            } else {
                                out.yield(AnalyzerInput(buffer: buf))
                            }
                        }
                        out.finish()
                    }
                }
                try await analyzer.start(inputSequence: inputs)
                let reader = Task {
                    for try await r in tr.results {
                        let text = String(r.text.characters)
                        guard let self else { return }
                        if r.isFinal { self.finalized = Self.join(self.finalized, text); self.volatile = "" } else { self.volatile = text }
                        let shown = Self.join(self.finalized, self.volatile).trimmingCharacters(in: .whitespaces)
                        DispatchQueue.main.async { cb.onText(shown) }
                    }
                }
                // Hold until the user stops talking (end()), then flush what's left.
                await self?.waitForEnd()
                try await analyzer.finalizeAndFinishThroughEndOfInput()
                try await reader.value
                DispatchQueue.main.async { cb.onDone() }
            } catch is CancellationError {
            } catch {
                DispatchQueue.main.async { cb.onError(error) }
            }
        }
    }

    private var ended = false, endWaiters: [CheckedContinuation<Void, Never>] = []
    private func waitForEnd() async {
        await withCheckedContinuation { c in
            DispatchQueue.main.async { if self.ended { c.resume() } else { self.endWaiters.append(c) } }
        }
    }

    private static func join(_ a: String, _ b: String) -> String {
        if a.isEmpty { return b }
        if b.isEmpty { return a }
        return a.hasSuffix(" ") || b.hasPrefix(" ") ? a + b : a + " " + b
    }

    private static func convert(_ buf: AVAudioPCMBuffer, with c: AVAudioConverter, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let cap = AVAudioFrameCount(Double(buf.frameLength) * format.sampleRate / buf.format.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { return nil }
        var fed = false
        var err: NSError?
        c.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buf
        }
        return err == nil && out.frameLength > 0 ? out : nil
    }

    func append(_ buffer: AVAudioPCMBuffer) { raw.yield(buffer) }
    func end() {
        raw.finish()
        DispatchQueue.main.async { self.ended = true; self.endWaiters.forEach { $0.resume() }; self.endWaiters = [] }
    }
    func cancel() {
        raw.finish()
        work?.cancel()
        DispatchQueue.main.async { self.ended = true; self.endWaiters.forEach { $0.resume() }; self.endWaiters = [] }
    }
}

// Before macOS 26: SFSpeechRecognizer. Needs Siri or Dictation turned on in System Settings.
final class LegacyRecognizer: Recognizer {
    private let req = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?

    /// onDeviceOnly: nil rather than sending audio to Apple's servers (wake listening, which hears everything).
    init?(_ cb: RecognizerCallbacks, onDeviceOnly: Bool = false) {
        guard let rec = legacySpeechLocale().flatMap({ SFSpeechRecognizer(locale: $0) }) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")), rec.isAvailable else { return nil }
        if onDeviceOnly && !rec.supportsOnDeviceRecognition { return nil }
        req.shouldReportPartialResults = true
        if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        if #available(macOS 13, *) { req.addsPunctuation = true }
        req.taskHint = .dictation
        req.contextualStrings = WakeWord.hints
        task = rec.recognitionTask(with: req) { result, error in
            DispatchQueue.main.async {
                if let result {
                    cb.onText(result.bestTranscription.formattedString)
                    if result.isFinal { cb.onDone() }
                }
                if let error { cb.onError(error) }
            }
        }
    }
    func append(_ buffer: AVAudioPCMBuffer) { req.append(buffer) }
    func end() { req.endAudio() }
    func cancel() { task?.cancel(); task = nil }
}

// Mutes the default output while you talk so music or videos don't drown you out (or end up in the
// transcript), then puts it back. Only ever un-mutes what it muted itself.
enum OutputMute {
    private static var device: AudioDeviceID?
    static var enabled = true

    private static func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }
    private static func defaultOutput() -> AudioDeviceID? {
        var id = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var a = addr(kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal)
        return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &id) == noErr && id != 0 ? id : nil
    }
    private static func muted(_ dev: AudioDeviceID) -> Bool? {
        var a = addr(kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput)
        guard AudioObjectHasProperty(dev, &a) else { return nil }
        var v = UInt32(0), size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(dev, &a, 0, nil, &size, &v) == noErr ? v != 0 : nil
    }
    private static func set(_ dev: AudioDeviceID, _ on: Bool) -> Bool {
        var a = addr(kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput)
        var v: UInt32 = on ? 1 : 0
        return AudioObjectSetPropertyData(dev, &a, 0, nil, UInt32(MemoryLayout<UInt32>.size), &v) == noErr
    }

    static func begin() {
        guard enabled, device == nil, let dev = defaultOutput(), muted(dev) == false else { return }
        if set(dev, true) { device = dev; log("output muted while listening") }
    }
    /// Unmute for a moment (a cue that must be heard while listening), then mute again if still listening.
    static func lift(for seconds: Double) {
        guard let dev = device, set(dev, false) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            if device == dev, muted(dev) == false { _ = set(dev, true) }
        }
    }
    static func end() {
        guard let dev = device else { return }
        device = nil
        // Unmute only if it's still muted: the user may have unmuted by hand meanwhile.
        if muted(dev) == true, set(dev, false) { log("output restored") }
    }
}

// Where the mic's buffers go: swapped on the main thread while the audio thread feeds it, so wake listening can
// start a fresh recogniser without reopening the mic.
final class Feed {
    private let lock = NSLock()
    private var target: Recognizer?
    func set(_ r: Recognizer?) { lock.lock(); target = r; lock.unlock() }
    func append(_ buffer: AVAudioPCMBuffer) { lock.lock(); let t = target; lock.unlock(); t?.append(buffer) }
}

// Wake listening keeps the mic open. On a Bluetooth headset that drops it (AirPods too) to call-quality sound for as
// long as it's on, so it listens on the built-in mic instead.
enum InputDevice {
    private static func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }
    private static func defaultInput() -> AudioDeviceID? {
        var id = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var a = addr(kAudioHardwarePropertyDefaultInputDevice)
        return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &id) == noErr && id != 0 ? id : nil
    }
    private static func transport(_ dev: AudioDeviceID) -> UInt32? {
        var v = UInt32(0), size = UInt32(MemoryLayout<UInt32>.size)
        var a = addr(kAudioDevicePropertyTransportType)
        return AudioObjectGetPropertyData(dev, &a, 0, nil, &size, &v) == noErr ? v : nil
    }
    private static func hasInput(_ dev: AudioDeviceID) -> Bool {
        var size = UInt32(0)
        var a = addr(kAudioDevicePropertyStreams, kAudioDevicePropertyScopeInput)
        return AudioObjectGetPropertyDataSize(dev, &a, 0, nil, &size) == noErr && size > 0
    }
    private static func all() -> [AudioDeviceID] {
        var size = UInt32(0)
        var a = addr(kAudioHardwarePropertyDevices)
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids) == noErr ? ids : []
    }
    /// The built-in mic when the default input is Bluetooth; nil means use the default.
    static func forWake() -> AudioDeviceID? {
        guard let dev = defaultInput(), let t = transport(dev), t == kAudioDeviceTransportTypeBluetooth || t == kAudioDeviceTransportTypeBluetoothLE else { return nil }
        return all().first { transport($0) == kAudioDeviceTransportTypeBuiltIn && hasInput($0) }
    }
    static func use(_ dev: AudioDeviceID, on input: AVAudioInputNode) -> Bool {
        guard let unit = input.audioUnit else { return false }
        var id = dev
        return AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr
    }
}

// Some mics (many USB, headset and webcam ones) deliver speech near -50 dBFS, too faint for Speech to make
// out words. Boost quiet speech toward ordinary level, at most +20 dB; normal and loud mics pass through as is.
// Only sounds well above the room's noise count as speech, so silence alone never raises the boost.
final class AutoGain {
    static let target: Float = 0.05 // about -26 dBFS RMS, ordinary speech
    static let maxGain: Float = 10
    private(set) var gain: Float = 1
    private var noise: Float = 0, speech: Float = 0

    /// Feed one buffer's RMS (before boosting); returns the boost for it.
    func next(_ rms: Float) -> Float {
        noise = noise == 0 ? max(rms, 1e-5) : rms < noise ? max(rms, 1e-5) : noise * 1.002
        if rms > noise * 3 && rms > 1e-4 { speech = max(speech, rms) } else { speech *= 0.998 }
        let want = speech > 0 ? min(Self.maxGain, max(1, Self.target / speech)) : 1
        // Down at once so a louder voice never clips; up gradually (about 0.5 s from 1x to 10x).
        gain = want < gain ? want : min(want, gain * 1.1)
        return gain
    }

    /// Boosts the buffer in place, ramping from the previous boost to avoid clicks.
    func apply(_ buffer: AVAudioPCMBuffer, rms: Float) {
        let from = gain, to = next(rms)
        guard let ch = buffer.floatChannelData, from != 1 || to != 1 else { return }
        let n = Int(buffer.frameLength), step = (to - from) / Float(max(n, 1))
        for c in 0 ..< Int(buffer.format.channelCount) {
            let x = ch[c]
            for i in 0 ..< n { x[i] = min(1, max(-1, x[i] * (from + step * Float(i + 1)))) }
        }
    }
}

// The wake phrase, "Hey Roamies": a greeting, then the name, at the start of something said (the text's start or
// after a sentence end). Near-misses the recogniser really writes count too ("Romies", "Roamie's", "Roomies").
// The name can be the user's own ("Hey Jarvis"); the greeting stays, so the name alone in a sentence never wakes it.
enum WakeWord {
    static let greetings: Set<String> = ["hey", "hi", "hay", "heya", "hiya"]
    static let defaultNames = ["roamies", "roamie"]
    // Set and read on the main thread.
    private(set) static var names = defaultNames
    /// The chosen name as a word for the recogniser's hints ("Jarvis"); nil for Roamies.
    private(set) static var custom: String?
    static var hints: [String] { ["Roamies", "Roamie", "JARVIS"] + (custom.map { [$0] } ?? []) }

    /// Sets the name after the greeting; nil, "" or Roamies goes back to Roamies. Letters only, 4 to 20 of them;
    /// anything else is refused (returns false) and the name stays as it was.
    @discardableResult static func setName(_ raw: String?) -> Bool {
        let w = (raw ?? "").lowercased().filter { $0.isLetter }
        if w.isEmpty || defaultNames.contains(w) { names = defaultNames; custom = nil; return true }
        guard w.count >= 4, w.count <= 20 else { return false }
        names = [w]
        custom = w.prefix(1).uppercased() + w.dropFirst()
        return true
    }

    /// Whether a heard word (within the allowed edits) is shaped like the name. Roamies keeps its own tuned rule.
    static func plausible(_ heard: String) -> Bool {
        guard custom != nil, let n = names.first else { return heard.hasPrefix("r") && heard.contains("m") && heard.count >= 5 }
        return heard.first == n.first && heard.count >= n.count - 1
    }

    /// Edits allowed for the next word, and one fewer for two words joined ("Roam ies"). A short name of the user's own
    /// must be heard exactly ("Nova" mustn't take "Nora"); 6 or 7 letters allow one edit, longer ones two.
    static var allowedEdits: Int {
        guard custom != nil else { return 2 }
        let n = names.first?.count ?? 0
        return n >= 8 ? 2 : n >= 6 ? 1 : 0
    }

    /// What was said after the phrase ("" if nothing yet), or nil when the phrase isn't there.
    static func match(_ text: String) -> String? { scan(text).rest }

    /// The match, plus the closest name's edit distance after a greeting (nil if no greeting), and when there's no match
    /// but it looks like a try, why it missed (for the log: never the words themselves).
    static func scan(_ text: String) -> (rest: String?, distance: Int?, miss: String?) {
        let words = tokens(text)
        var closest: Int?, late = false
        for (i, w) in words.enumerated() where greetings.contains(w.word) && i + 1 < words.count {
            let before = text[(i == 0 ? text.startIndex : words[i - 1].range.upperBound) ..< w.range.lowerBound]
            // Up to two stray words may come first ("um", "okay", a cough heard as "the"); live text rarely has a full stop.
            let atStart = i <= 2 || before.contains(where: { ".?!".contains($0) })
            // Only spaces or a comma between greeting and name ("Hey, Roamies").
            guard text[w.range.upperBound ..< words[i + 1].range.lowerBound].allSatisfy({ $0 == " " || $0 == "," }) else { continue }
            var candidates = [(words[i + 1].word, words[i + 1].range.upperBound, allowedEdits)]
            // Split in two ("Roam ies"): joined, it must be a closer match.
            if i + 2 < words.count { candidates.append((words[i + 1].word + words[i + 2].word, words[i + 2].range.upperBound, allowedEdits - 1)) }
            for (name, end, allowed) in candidates {
                let d = distance(name)
                closest = min(closest ?? d, d)
                if d <= allowed && plausible(name) {
                    guard atStart else { late = true; continue }
                    let rest = text[end...].drop(while: { !$0.isLetter && !$0.isNumber })
                    return (String(rest).trimmingCharacters(in: .whitespacesAndNewlines), d, nil)
                }
            }
        }
        if late { return (nil, closest, "the phrase came after other words") }
        if let c = closest, c <= 4 { return (nil, closest, "a greeting, then a name \(c) letters off") }
        let initial = names.first?.first ?? "r"
        if words.contains(where: { $0.word.first == initial && distance($0.word) <= 2 }) { return (nil, closest, "the name without a greeting") }
        return (nil, closest, nil)
    }

    /// Lowercased words without apostrophes ("Roamie's" -> "roamies"), with where each sits in the text.
    static func tokens(_ text: String) -> [(word: String, range: Range<String.Index>)] {
        var out: [(word: String, range: Range<String.Index>)] = []
        var start: String.Index?
        var i = text.startIndex
        while true {
            let c: Character? = i == text.endIndex ? nil : text[i]
            let inWord = c.map { $0.isLetter || $0.isNumber || (($0 == "'" || $0 == "\u{2019}") && start != nil) } ?? false
            if inWord { if start == nil { start = i } }
            else if let s = start {
                let w = text[s ..< i].lowercased().filter { $0 != "'" && $0 != "\u{2019}" }
                if !w.isEmpty { out.append((w, s ..< i)) }
                start = nil
            }
            if c == nil { break }
            i = text.index(after: i)
        }
        return out
    }

    static func distance(_ word: String) -> Int { names.map { edits(word, $0) }.min() ?? Int.max }

    static func edits(_ a: String, _ b: String) -> Int {
        let a = Array(a), b = Array(b)
        if a.isEmpty || b.isEmpty { return max(a.count, b.count) }
        var prev = Array(0 ... b.count), cur = prev
        for i in 1 ... a.count {
            cur[0] = i
            for j in 1 ... b.count { cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)) }
            swap(&prev, &cur)
        }
        return prev[b.count]
    }
}

final class Voice {
    // wake: listening quietly for "Hey Roamies" or two claps (no pill, nothing muted); either turns into a hands-free take.
    enum Phase { case idle, wake, armed, holding, handsFree, finishing }

    private var phase = Phase.idle
    private var chordAt = 0.0, listenAt = 0.0, heardAt = 0.0, voiceAt = 0.0, levelAt = 0.0, releasedAt: Double?
    // When talking ended and what finished the words (the recogniser, its 2.5 s cap): sent with them, for timing.
    private var finishedAt = 0.0, endedVia = ""
    private var blocked = false, prevChord = false, authorizing = false, reportEmpty = false, failed = false
    // The keys already reading down when the chord went down: they can't be part of its shortcut (isShortcut).
    private var heldAtArm = Set<CGKeyCode>()
    private var engine: AVAudioEngine?
    // Kept across sessions (same mic, usually), so later takes start at the right boost.
    private let autoGain = AutoGain()
    private var rec: Recognizer?
    private var best = ""
    private var finishTimer: Timer?
    private let feed = Feed()
    private var configObserver: NSObjectProtocol?
    // Wake word: on in settings; held off while Roamies answers and speaks; resting just after a take.
    private var wakeOn = false
    // Clap to wake: two claps start a take, like the phrase. Either one keeps the quiet listening on.
    private var clapsOn = false
    private var listensForWake: Bool { wakeOn || clapsOn }
    var wakeHold = false {
        didSet { if listensForWake && wakeHold != oldValue { wakeLog(wakeHold ? "paused while Roamies answers" : "resumed") } }
    }
    private var wakeLoud = 0.0, wakeLevelAt = 0.0 // seconds loud enough to be speech in this wake window
    private var wakeCooldownUntil = 0.0, wakeRetryAt = 0.0, wakeAt = 0.0
    private var wakeText = "", woke = false, wakeMiss: String?
    private var useAnalyzer: Bool { if #available(macOS 26, *) { return SpeechTranscriber.isAvailable } else { return false } }

    init() {
        // Resolve the locale and fetch the model up front so the first ⌃⌥ is instant.
        if #available(macOS 26, *), SpeechTranscriber.isAvailable { _ = AnalyzerRecognizer.prepare() }
    }

    // The talk chord: any two of ⌃ ⌥ ⌘ ⇧ (default ⌃⌥). Set with --chord or {"cmd":"chord"}.
    private static let allMods: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand, .maskShift]
    private var chordMask: CGEventFlags = [.maskControl, .maskAlternate]
    static func mask(_ names: [String]) -> CGEventFlags? {
        var m: CGEventFlags = []
        for n in names {
            switch n.lowercased() {
            case "control", "ctrl": m.insert(.maskControl)
            case "option", "alt": m.insert(.maskAlternate)
            case "command", "cmd": m.insert(.maskCommand)
            case "shift": m.insert(.maskShift)
            default: return nil
            }
        }
        return names.count == 2 && m.rawValue.nonzeroBitCount == 2 ? m : nil
    }
    func setChord(_ names: [String]) {
        guard let m = Self.mask(names) else { return log("ignored chord \(names)") }
        if phase == .wake { stopWake() } else if phase != .idle { cancel() }
        chordMask = m; blocked = true
        log("talk chord: \(names.joined(separator: "+"))")
    }

    private static let modifierKeys: Set<CGKeyCode> = [0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F]
    private static let tapLimit = 0.25
    // A release must last this long to count, so one glitchy frame of key state can't end a session.
    private static let releaseDebounce = 0.09
    private static let pauseEnds = 1.5
    private static let wordsEnd = 2.5 // hands-free: no new words for this long ends it, even with background sound
    private static let maxSession = 60.0
    private static let wakeRecycle = 30.0 // a fresh wake recogniser this often, so memory stays bounded
    private static let wakePause = 1.2 // words stopped this long without the phrase: start fresh for the next thing said
    private static let wakeCooldown = 2.0

    var engineName: String { useAnalyzer ? "speechanalyzer" : "sfspeech" }

    // ---------- hotkey ----------

    private func keysDown() -> Set<CGKeyCode> {
        Set((CGKeyCode(0) ..< 0x80).filter { !Self.modifierKeys.contains($0) && CGEventSource.keyState(.combinedSessionState, key: $0) })
    }

    /// At the chord's first moment: an extra ⇧ or ⌘, or a key pressed since the chord went down, makes it a shortcut
    /// (⌃⌥S), not a talk. A key that already read as down then doesn't count: macOS can report a key as held that
    /// isn't (seen: one key code reading down at almost every press, which a real press of it didn't clear), and that
    /// turned nearly every talk into a "shortcut".
    static func isShortcut(extra: Bool, heldAtArm: Set<CGKeyCode>, now: Set<CGKeyCode>) -> Bool {
        extra || !now.subtracting(heldAtArm).isEmpty
    }

    let ink = Ink()
    let wave = Wave()
    let buddy = Buddy()

    // ---------- clicks under a drawing ----------
    // Only while the sidekick has a drawing on a window (it says so): each click on another app is reported, with
    // whether it's on something that does something, so the drawing goes with the screen it was about. A global
    // monitor, not the button state, so a tap-to-click (shorter than a frame) isn't missed.
    private var clickMonitor: Any?
    private let clickQueue = DispatchQueue(label: "roamies.voice.clicks")
    var watchClicks = false {
        didSet {
            guard watchClicks != oldValue else { return }
            if watchClicks { clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown]) { [weak self] e in self?.clicked(count: e.clickCount) } }
            else if let m = clickMonitor { NSEvent.removeMonitor(m); clickMonitor = nil }
        }
    }
    private func clicked(count: Int) {
        let m = NSEvent.mouseLocation, top = NSScreen.screens.first?.frame.maxY ?? 0, p = CGPoint(x: m.x, y: top - m.y)
        clickQueue.async {
            guard let hit = ClickTarget.at(p) else { return }
            let acts = ClickTarget.acts(roles: hit.roles, count: count)
            DispatchQueue.main.async { emit(["type": "click", "x": Int(p.x.rounded()), "y": Int(p.y.rounded()), "role": hit.roles.first ?? "", "app": hit.app, "acts": acts]) }
        }
    }

    func tick() {
        // Drawing follows the keys: only while ⌃⌥ is down for a talk.
        defer { ink.setArmed(phase == .armed || phase == .holding); ink.follow(); wave.tick(); buddy.tick() }
        let now = uptime()
        let f = CGEventSource.flagsState(.combinedSessionState).intersection(Self.allMods)
        let held = f.intersection(chordMask)
        let down = held == chordMask // once talking, a stray extra modifier doesn't count as letting go
        let extra = !f.subtracting(chordMask).isEmpty
        let chord = down && !extra
        defer { prevChord = chord }
        if held.isEmpty { blocked = false }

        // Debounced release: true only once ⌃⌥ has been up for releaseDebounce.
        let released: Bool = {
            if down { releasedAt = nil; return false }
            if releasedAt == nil { releasedAt = now }
            return now - (releasedAt ?? now) >= Self.releaseDebounce
        }()

        switch phase {
        case .idle:
            if chord && !prevChord && !blocked { arm(now) }
            else if wakeAllowed(now) { startWake(now) }
        case .wake:
            if chord && !prevChord && !blocked { stopWake(); arm(now); return }
            if !listensForWake || wakeHold { stopWake(); return }
            let paused = !wakeText.isEmpty && now - heardAt > Self.wakePause && now - voiceAt > Self.wakePause / 2
            // The 30 s refresh waits for a quiet moment, so it can't split "Hey" from "Roamies".
            let quiet = now - voiceAt > Self.wakePause / 2 && now - heardAt > Self.wakePause
            if paused || (now - wakeAt > Self.wakeRecycle && quiet) || now - wakeAt > Self.wakeRecycle * 2 { recycleWake(now) }
        case .armed:
            // Only the first moment decides shortcut vs. talk: ⌃⌥ plus a key pressed since, ⇧ or ⌘ is a shortcut.
            if down && Self.isShortcut(extra: extra, heldAtArm: heldAtArm, now: keysDown()) { log("not a talk: ⌃⌥ was part of a shortcut"); cancel(); blocked = true; return }
            if released { phase = .handsFree; showListening("handsfree", now); return }
            if down && now - chordAt >= Self.tapLimit { phase = .holding; showListening("hold", now) }
        case .holding:
            if released { end("released"); finish(); return }
            if now - listenAt > Self.maxSession { end("max length"); finish() }
        case .handsFree:
            // Pressing again switches to push-to-talk; letting go then sends.
            if chord && !prevChord && !blocked { phase = .holding; releasedAt = nil; return }
            let quiet = now - max(heardAt, voiceAt)
            // Steady sound in the room (a fan, music) keeps the level up, so words that stopped coming end it too.
            if !best.isEmpty && (quiet > Self.pauseEnds || now - heardAt > Self.wordsEnd) { end(quiet > Self.pauseEnds ? "pause" : "no new words"); finish() }
            else if best.isEmpty && now - listenAt > 8 { end("nothing heard"); cancel() }
            else if now - listenAt > Self.maxSession { end("max length"); finish() }
        case .finishing:
            break
        }
    }

    private func end(_ why: String) { log("session end: \(why) after \(String(format: "%.1f", uptime() - listenAt))s, mic boost \(String(format: "%.1f", autoGain.gain))x") }

    // ---------- session ----------

    private func arm(_ now: Double) {
        phase = .armed
        chordAt = now
        heldAtArm = keysDown()
        if !heldAtArm.isEmpty { log("chord: keys already down don't count toward a shortcut: \(heldAtArm.sorted())") }
        best = ""
        woke = false
        // The drawing layer first: starting the mic below holds this thread for a moment (longer with Bluetooth),
        // and a drag begun in that moment would otherwise land in the app underneath.
        ink.setArmed(true)
        // ROAMIES_VOICE_DRYRUN_TEXT: what a dry run "hears", to test what goes out with the words (like pen marks).
        if dryRun { best = ProcessInfo.processInfo.environment["ROAMIES_VOICE_DRYRUN_TEXT"] ?? ""; return }
        // Already allowed: start the mic now so the first word isn't lost. Otherwise wait until
        // the press is clearly a talk (hold or tap), so shortcuts like ⌃⌥S never trigger a prompt.
        if authorized { startAudio() }
    }

    private var authorized: Bool {
        LiveTest.url != nil || AVCaptureDevice.authorizationStatus(for: .audio) == .authorized && (useAnalyzer || SFSpeechRecognizer.authorizationStatus() == .authorized)
    }

    private func showListening(_ mode: String, _ now: Double) {
        listenAt = now; heardAt = now; voiceAt = now
        if !dryRun && rec == nil {
            ensureAuthorized { [weak self] in
                guard let self, self.phase == .holding || self.phase == .handsFree, self.rec == nil else { return }
                self.startAudio()
            }
        }
        if !dryRun { OutputMute.begin() }
        wave.show()
        // wave: the cursor shows the listening, so the app shows no listening bubble.
        emit(["type": "state", "state": "listening", "mode": mode, "wave": true])
        if !best.isEmpty { emit(["type": "partial", "text": best]) }
    }

    private func finish() {
        guard phase == .armed || phase == .holding || phase == .handsFree else { return }
        let shown = phase != .armed
        reportEmpty = shown && !failed
        phase = .finishing
        finishedAt = uptime(); endedVia = "recognizer"
        wave.think()
        wave.setHidden(true)
        ink.capture { [weak self] in self?.wave.setHidden(false) }
        if shown { emit(["type": "state", "state": "processing"]) }
        guard let r = rec, !failed else { stopAudio(); endedVia = "failed"; finalize(); return }
        // Keep the mic open a moment after release so a word said while letting go isn't clipped.
        let tail = Timer(timeInterval: 0.3, repeats: false) { [weak self] _ in
            guard let self, self.phase == .finishing, self.rec === r else { return }
            self.stopAudio()
            r.end()
            let t = Timer(timeInterval: 2.5, repeats: false) { [weak self] _ in self?.endedVia = "cap"; self?.finalize() }
            RunLoop.main.add(t, forMode: .common)
            self.finishTimer = t
        }
        RunLoop.main.add(tail, forMode: .common)
        finishTimer = tail
    }

    private func finalize() {
        guard phase == .finishing else { return }
        finishTimer?.invalidate(); finishTimer = nil
        rec?.cancel(); rec = nil
        phase = .idle
        woke = false; wakeCooldownUntil = uptime() + Self.wakeCooldown
        let text = best.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { wave.hide() } else { wave.awaitAnswer() }
        let empty = text.isEmpty && reportEmpty, spoke = voiceAt > listenAt + 0.05
        reportEmpty = false
        let rest = {
            emit(["type": "state", "state": "idle"])
            // Listened but got no words: say so instead of closing silently.
            if empty { emit(["type": "error", "code": "nothing_heard", "spoke": spoke]) }
        }
        if text.isEmpty {
            // Circled something but said nothing: drop it quietly and just go (no "I didn't hear you").
            ink.take { area in
                guard let file = area?["file"] as? String else { return rest() }
                try? FileManager.default.removeItem(atPath: file)
                log("nothing said, dropped the circled area")
                emit(["type": "state", "state": "idle"])
            }
            return
        }
        // What was marked on screen while talking rides along with the words.
        ink.take { area in
            var msg: [String: Any] = ["type": "final", "text": text, "ms": Int(((uptime() - self.finishedAt) * 1000).rounded()), "via": self.endedVia]
            if let area { msg["area"] = area }
            log("sent what was said\(area == nil ? "" : ", with the circled area")")
            emit(msg)
            rest()
        }
    }

    private func cancel() {
        stopAudio()
        rec?.cancel(); rec = nil
        finishTimer?.invalidate(); finishTimer = nil
        phase = .idle
        woke = false; wakeCooldownUntil = uptime() + Self.wakeCooldown
        reportEmpty = false
        ink.clear()
        wave.hide()
        emit(["type": "state", "state": "idle", "cancelled": true])
    }

    /// The shell saw ⌃⌥S: that ⌃⌥ was a shortcut, not a request to talk.
    /// Start listening hands-free without a key press (after an area snap). Ends on a pause or a tap.
    func listenNow() {
        if phase == .wake { stopWake() }
        guard phase == .idle else { return }
        arm(uptime())
        phase = .handsFree
        blocked = true // the snap shortcut's keys may still be held: don't read them as a tap
        showListening("handsfree", uptime())
    }

    func externalCancel() {
        if phase == .armed || phase == .holding || phase == .handsFree { cancel() }
        blocked = true
    }

    // ---------- wake word ----------

    func setWake(_ on: Bool) {
        guard on != wakeOn else { return }
        wakeOn = on
        log("wake word \(on ? "on" : "off")")
        if !on && !clapsOn { stopWake() }
    }

    func setClaps(_ on: Bool) {
        guard on != clapsOn else { return }
        clapsOn = on
        log("clap to wake \(on ? "on" : "off")")
        if !on && !wakeOn { stopWake() }
    }

    // Never asks for permission: wake listening starts only once talking has been allowed.
    private func wakeAllowed(_ now: Double) -> Bool {
        listensForWake && !wakeHold && !dryRun && now >= wakeCooldownUntil && now >= wakeRetryAt && authorized
    }

    private func startWake(_ now: Double) {
        wakeRetryAt = now + 5 // if the mic won't open, try again in a moment rather than every frame
        phase = .wake
        best = ""; wakeText = ""; wakeMiss = nil; woke = false; wakeLoud = 0
        wakeAt = now; heardAt = now; voiceAt = now
        let device = InputDevice.forWake()
        startAudio(device: device)
        if phase == .wake { wakeLog("listening\(device == nil ? "" : " on the built-in mic (the default input is Bluetooth)")") }
    }

    private func stopWake() {
        guard phase == .wake else { return }
        logNearMiss()
        stopAudio()
        rec?.cancel(); rec = nil
        phase = .idle
        best = ""; wakeText = ""
    }

    // A fresh recogniser on the open mic: after a pause with no phrase (so it must start what's said next), or every 30 s.
    private func recycleWake(_ now: Double) {
        logNearMiss()
        guard freshRecognizer() else { stopWake(); wakeRetryAt = now + 30; return }
        wakeAt = now; heardAt = now; wakeText = ""
    }

    /// A new recogniser on the open mic, for the phase it's in now (on-device only while waiting for the wake word).
    /// False if none could be made.
    private func freshRecognizer() -> Bool {
        feed.set(nil)
        rec?.cancel(); rec = nil
        guard let r = makeRecognizer() else { return false }
        rec = r; feed.set(r)
        return true
    }

    /// Wake listening becomes a hands-free take (the phrase was said, or two claps heard). rest: what was already said
    /// after the phrase, the start of the request.
    private func beginWokenTake(_ now: Double, rest: String) {
        woke = true
        phase = .handsFree
        chordAt = now
        best = rest
        showListening("wake", now)
    }

    // Only how close it came, never what was said.
    private func logNearMiss() {
        guard wakeOn else { wakeMiss = nil; wakeLoud = 0; return } // claps only: what the recogniser heard doesn't matter
        // How a window ended, never what was said: a near try, other words, or sound the recogniser made no words of.
        if let m = wakeMiss { wakeLog("missed (\(m))") }
        else if !wakeText.isEmpty { wakeLog("heard \(WakeWord.tokens(wakeText).count) words, not the phrase") }
        else if wakeLoud >= 0.5 { wakeLog("heard sound for \(String(format: "%.1f", wakeLoud)) s, but no words came back") }
        wakeMiss = nil; wakeLoud = 0
    }

    private func heardWhileWaiting(_ text: String) {
        guard text != wakeText else { return }
        let now = uptime()
        wakeText = text; heardAt = now
        guard wakeOn else { return } // clap to wake only: the phrase doesn't count
        let (rest, d, miss) = WakeWord.scan(text)
        guard let rest else { if let miss { wakeMiss = miss }; return }
        wakeLog("heard the phrase (distance \(d ?? 0))")
        wakeMiss = nil
        // Same mic, same recogniser: what follows the phrase is already the start of the take.
        beginWokenTake(now, rest: rest)
    }

    /// Two claps heard on the mic (the audio thread found them). Like the phrase, but with a fresh recogniser, so words
    /// heard before the claps aren't taken as the start of the request.
    private func heardClaps() {
        guard phase == .wake, clapsOn, !wakeHold else { return }
        let now = uptime()
        wakeLog("heard two claps")
        logNearMiss()
        phase = .handsFree // before the new recogniser: a take may use the full one, wake listening only the on-device one
        guard freshRecognizer() else { phase = .wake; stopWake(); wakeRetryAt = now + 30; return }
        wakeText = ""
        beginWokenTake(now, rest: "")
    }

    // ---------- permissions ----------

    private func ensureAuthorized(_ then: @escaping () -> Void) {
        let mic = AVCaptureDevice.authorizationStatus(for: .audio)
        let speech = SFSpeechRecognizer.authorizationStatus()
        if mic == .authorized && (useAnalyzer || speech == .authorized) { then(); return }
        if mic == .denied || mic == .restricted { return denied("microphone") }
        if speech == .denied || speech == .restricted { return denied("speech") }
        if authorizing { return }
        authorizing = true
        AVCaptureDevice.requestAccess(for: .audio) { micOK in
            guard micOK else {
                DispatchQueue.main.async { self.authorizing = false; self.denied("microphone") }
                return
            }
            if self.useAnalyzer { DispatchQueue.main.async { self.authorizing = false; then() }; return }
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async {
                    self.authorizing = false
                    if status == .authorized { then() } else { self.denied("speech") }
                }
            }
        }
    }

    private func denied(_ what: String) {
        emit(["type": "error", "code": "permission", "what": what])
        cancel()
    }

    // ---------- audio + recognition ----------

    private func makeRecognizer() -> Recognizer? {
        var mine: Recognizer?
        let cb = RecognizerCallbacks(
            onText: { [weak self] text in guard let self, self.rec === mine else { return }; self.onText(text) },
            onDone: { [weak self] in
                guard let self, self.rec === mine else { return }
                if self.phase == .wake { self.recycleWake(uptime()) } else if self.phase == .finishing { self.finalize() }
            },
            onError: { [weak self] err in guard let self, self.rec === mine else { return }; self.onError(err) }
        )
        if #available(macOS 26, *), useAnalyzer { mine = AnalyzerRecognizer(cb) } else { mine = LegacyRecognizer(cb, onDeviceOnly: phase == .wake) }
        return mine
    }

    /// device: a particular mic instead of the default one (wake listening, when the default is Bluetooth).
    private func startAudio(device: AudioDeviceID? = nil) {
        failed = false
        // Wake listening fails quietly and tries again later; a take tells the user.
        let fail = { (code: String) in
            if self.phase == .wake { self.phase = .idle; self.wakeRetryAt = uptime() + 30; wakeLog("couldn't start (\(code))") } else { emit(["type": "error", "code": code]); self.cancel() }
        }
        guard let r = makeRecognizer() else { return fail("unavailable") }
        let gain = autoGain, feed = feed, claps = ClapDetector()
        let ingest = { [weak self] (buffer: AVAudioPCMBuffer) in
            guard let samples = buffer.floatChannelData?[0] else { feed.append(buffer); return }
            let n = Int(buffer.frameLength)
            // Claps are judged on the mic's own level, before the boost below changes the samples.
            if claps.feed(samples, count: n, rate: buffer.format.sampleRate) > 0 { DispatchQueue.main.async { self?.heardClaps() } }
            var sum: Float = 0
            for i in 0 ..< n { sum += samples[i] * samples[i] }
            let rms = sqrt(sum / Float(max(n, 1)))
            gain.apply(buffer, rms: rms)
            feed.append(buffer)
            // Level and pause detection use the mic's own level, so boosted room noise can't hold a session open.
            let level = min(1, max(0, (Double(20 * log10(max(rms, 1e-7))) + 55) / 40))
            DispatchQueue.main.async { self?.onLevel(level) }
        }
        if LiveTest.url != nil { feed.set(r); rec = r; LiveTest.sink = ingest; return }

        let eng = AVAudioEngine()
        let input = eng.inputNode
        if let device, !InputDevice.use(device, on: input) { log("couldn't switch to the built-in mic") }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            r.cancel()
            return fail("no_input")
        }
        feed.set(r)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in ingest(buffer) }
        do {
            eng.prepare()
            try eng.start()
        } catch {
            log("engine start failed: \(error)")
            feed.set(nil)
            r.cancel()
            return fail("no_input")
        }
        engine = eng
        rec = r
        // A mic plugged in or out stops the engine: wake listening starts again on the new one.
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: eng, queue: .main) { [weak self] _ in
            guard let self, self.engine === eng, self.phase == .wake else { return }
            wakeLog("audio devices changed")
            self.stopWake()
        }
    }

    private func stopAudio() {
        OutputMute.end()
        feed.set(nil)
        LiveTest.sink = nil
        if let o = configObserver { NotificationCenter.default.removeObserver(o); configObserver = nil }
        guard let eng = engine else { return }
        eng.inputNode.removeTap(onBus: 0)
        eng.stop()
        engine = nil
    }

    private func onLevel(_ v: Double) {
        let now = uptime()
        if phase == .wake { if v > 0.2 { wakeLoud += min(0.2, now - wakeLevelAt) }; wakeLevelAt = now }
        if v > 0.2 { voiceAt = now }
        if phase == .holding || phase == .handsFree { wave.setLevel(v) }
        guard phase == .holding || phase == .handsFree, now - levelAt >= 0.05 else { return }
        levelAt = now
        emit(["type": "level", "v": (v * 100).rounded() / 100])
    }

    private func onText(_ raw: String) {
        if phase == .wake { return heardWhileWaiting(raw) }
        // A take started by the wake phrase: the phrase itself isn't part of what was said.
        let text = woke ? (WakeWord.match(raw) ?? raw) : raw
        guard text != best else { return }
        best = text
        heardAt = uptime()
        if phase != .armed && phase != .idle { emit(["type": "partial", "text": text]) }
    }

    private func onError(_ error: Error) {
        let msg = error.localizedDescription
        // Ending a request early reports "no speech"/cancel errors; only real failures reach the user.
        let ns = error as NSError
        let benign = ns.domain == "kAFAssistantErrorDomain" && [203, 216, 301, 1110].contains(ns.code)
        // Wake listening never bothers the user: start fresh, or rest a while after a real failure.
        if phase == .wake {
            if benign { recycleWake(uptime()) } else { wakeLog("recognition: \(msg)"); stopWake(); wakeRetryAt = uptime() + 30 }
            return
        }
        log("recognition: \(msg)")
        if !benign && best.isEmpty {
            failed = true
            let code = msg.localizedCaseInsensitiveContains("dictation") || msg.localizedCaseInsensitiveContains("siri") ? "dictation_off" : "recognition"
            emit(["type": "error", "code": code, "message": msg])
        }
        // A failed recognizer can't hear anything more, so end; otherwise keep listening while held.
        if phase == .finishing { finalize() }
        else if failed { end("recognition error"); finish() }
    }
}

// ---------- one-shot permission modes (used by the setup guide) ----------
// --perms prints the current state; --request <mic|speech|screen> asks, then prints the state.
// Run as a child of Roamies, so macOS attributes the prompts and grants to Roamies.
func permStatus() -> [String: Any] {
    func av(_ s: AVAuthorizationStatus) -> String { s == .authorized ? "granted" : s == .notDetermined ? "unknown" : "denied" }
    func sp(_ s: SFSpeechRecognizerAuthorizationStatus) -> String { s == .authorized ? "granted" : s == .notDetermined ? "unknown" : "denied" }
    var analyzer = false
    if #available(macOS 26, *) { analyzer = SpeechTranscriber.isAvailable }
    return [
        "type": "perms",
        "mic": av(AVCaptureDevice.authorizationStatus(for: .audio)),
        // SpeechAnalyzer (macOS 26+) needs no speech-recognition permission.
        "speech": analyzer ? "granted" : sp(SFSpeechRecognizer.authorizationStatus()),
        "speechNeeded": !analyzer,
        "screen": CGPreflightScreenCaptureAccess() ? "granted" : "unknown",
    ]
}
let args = CommandLine.arguments
// --test-gain checks the quiet-mic boost with made-up levels; exits 1 on a failure.
if args.contains("--test-gain") {
    var bad = 0
    func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
    func run(_ g: AutoGain, _ rms: Float, _ n: Int) { for _ in 0 ..< n { _ = g.next(rms) } }
    var g = AutoGain(); run(g, 0.001, 50); run(g, 0.06, 50)
    check("normal mic stays at 1x", g.gain == 1)
    g = AutoGain(); run(g, 0.0003, 50); run(g, 0.003, 30)
    check("quiet mic (-50 dB) boosted to 10x within 0.7 s", g.gain == AutoGain.maxGain)
    g = AutoGain(); run(g, 0.0003, 50); run(g, 0.01, 50)
    check("slightly quiet mic boosted just to ordinary level", abs(g.gain - 5) < 0.01)
    g = AutoGain(); run(g, 0.0005, 500)
    check("silence alone never boosted", g.gain == 1)
    g = AutoGain(); run(g, 0.0003, 50); run(g, 0.003, 50); _ = g.next(0.2)
    check("loud sound drops the boost at once", g.gain == 1)
    let fmt = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 4)!
    buf.frameLength = 4
    for c in 0 ..< 2 { for i in 0 ..< 4 { buf.floatChannelData![c][i] = 0.5 } }
    g = AutoGain(); run(g, 0.0003, 50); run(g, 0.003, 50); g.apply(buf, rms: 0.003)
    check("boost applies to every channel and never clips", (0 ..< 2).allSatisfy { c in buf.floatChannelData![c][3] == 1 })
    exit(bad == 0 ? 0 : 1)
}
// --test-wake checks the wake phrase matcher on transcripts the recogniser could write; exits 1 on a failure.
if args.contains("--test-wake") {
    var bad = 0
    func check(_ text: String, _ want: String?) {
        let got = WakeWord.match(text)
        print("\(got == want ? "ok" : "FAIL") \"\(text)\" -> \(got.map { "\"\($0)\"" } ?? "no wake")")
        if got != want { bad += 1 }
    }
    check("Hey Roamies", "")
    check("Hey Roamies, open Safari.", "open Safari.")
    check("hey roamies open safari", "open safari")
    check("Hey, Roamies.", "")
    check("Hi Roamies what time is it?", "what time is it?")
    check("Hey Romies", "")
    check("Hey Roamie's, open Notes", "open Notes")
    check("Hey Roamie", "")
    check("Hey Roomies, play some music", "play some music")
    check("Hey Romi's", "")
    check("Hey, Romees.", "")
    check("Hey Romy's", nil) // three edits away
    check("Hey roam ies, hello", "hello")
    check("That's it. Hey Roamies, open Mail", "open Mail")
    check("HEY ROAMIES! What's on today?", "What's on today?")
    check("Hey Roamies\u{2019} open notes", "open notes")
    check("Hey Ronnie", nil)
    check("Hey Robbie, come here", nil)
    check("Hey Rome", nil)
    check("Hey rooms", nil)
    check("Hey ramen", nil)
    check("Hey Remy", nil)
    check("Hey rhymes", nil)
    check("Hey room is ready", nil)
    check("Roamies is great", nil)
    check("I told him hey Roamies", nil)
    check("Um hey Roamies, open Mail", "open Mail")
    check("Okay, hi Roamies", "")
    check("The hey Romies what time is it", "what time is it")
    check("So I said hey Roamies", nil)
    check("Hey there", nil)
    check("Hey", nil)
    check("Hey. Roamies", nil)
    check("", nil)
    // A name of the user's own.
    func named(_ ok: Bool, _ name: String) { let got = WakeWord.setName(name); print("\(got == ok ? "ok" : "FAIL") name \"\(name)\" \(ok ? "taken" : "refused")"); if got != ok { bad += 1 } }
    named(false, "Bob")
    named(false, "a really very long name for this")
    named(true, "Jarvis")
    check("Hey Jarvis", "")
    check("Hey Jarvis, open Safari.", "open Safari.")
    check("hi jarvis what time is it", "what time is it")
    check("Hey Jervis, open Notes", "open Notes")
    check("Hey Jar vis, hello", "hello")
    check("Hey Travis", nil)
    check("Hey Service", nil)
    check("Hey Roamies", nil)
    check("Jarvis is great", nil)
    check("I told him hey Jarvis", nil)
    named(true, "Nova")
    check("Hey Nova, play music", "play music")
    check("Hey Nora", nil) // a short name must be heard exactly
    named(true, "")
    check("Hey Roamies, open Mail", "open Mail")
    check("Hey Jarvis", nil)
    exit(bad == 0 ? 0 : 1)
}
// --test-claps checks the double-clap detector on made-up sounds (clap.swift); exits 1 on a failure.
if args.contains("--test-claps") {
    var bad = 0
    func check(_ name: String, _ got: Int, _ want: Int) { print("\(got == want ? "ok" : "FAIL") \(name) (\(got))"); if got != want { bad += 1 } }
    func heard(rate: Double = 48000, secs: Double = 4, _ make: (ClapScene) -> Void) -> Int {
        let s = ClapScene(rate: rate, secs: secs); make(s); return s.doubleClaps()
    }
    check("two claps", heard { $0.clap(1); $0.clap(1.35) }, 1)
    check("two claps, fast", heard { $0.clap(1); $0.clap(1.18) }, 1)
    check("two claps, slow", heard { $0.clap(1); $0.clap(1.7) }, 1)
    check("two claps in an echoey room", heard { $0.clap(1, 0.6, reverb: 0.12); $0.clap(1.4, 0.6, reverb: 0.12) }, 1)
    check("two softer claps", heard { $0.clap(1, 0.2); $0.clap(1.3, 0.25) }, 1)
    check("two claps at 44.1 kHz", heard(rate: 44100) { $0.clap(1); $0.clap(1.3) }, 1)
    check("two claps at 16 kHz", heard(rate: 16000) { $0.clap(1); $0.clap(1.3) }, 1)
    check("two claps, then talking", heard { $0.clap(1); $0.clap(1.3); $0.speech(2.0, 3.8) }, 1)
    check("two claps after talking stops", heard { $0.speech(0, 1.0); $0.clap(1.6); $0.clap(1.9) }, 1)
    check("two claps with quiet talking around them", heard { $0.speech(0, 4, 0.02); $0.clap(1.5); $0.clap(1.8) }, 1)
    check("two pairs, far apart", heard(secs: 6) { $0.clap(1); $0.clap(1.3); $0.clap(4); $0.clap(4.3) }, 2)
    check("one clap", heard { $0.clap(1) }, 0)
    check("three claps", heard { $0.clap(1); $0.clap(1.3); $0.clap(1.6) }, 0)
    check("applause", heard { s in for k in 0 ..< 14 { s.clap(0.5 + Double(k) * 0.17) } }, 0)
    check("claps too far apart", heard { $0.clap(1); $0.clap(2.1) }, 0)
    check("claps too close (one clap with a flam)", heard { $0.clap(1); $0.clap(1.06) }, 0)
    check("one loud, one faint", heard { $0.clap(1, 0.8); $0.clap(1.3, 0.08) }, 0)
    check("far-off claps, too quiet", heard { $0.clap(1, 0.02); $0.clap(1.3, 0.02) }, 0)
    check("talking", heard { $0.speech(0.2, 3.8) }, 0)
    check("loud talking", heard { $0.speech(0.2, 3.8, 0.5) }, 0)
    check("typing", heard { s in var t = 0.3; while t < 3.8 { s.tap(t); t += 0.09 + 0.12 * abs(s.rnd()) } }, 0)
    check("two claps right after talking", heard { $0.speech(0, 1.0); $0.clap(1.1); $0.clap(1.4) }, 0)
    check("two claps over loud talking", heard { $0.speech(0, 4, 0.3); $0.clap(1.5); $0.clap(1.8) }, 0)
    check("silence", heard { _ in }, 0)
    // Many random pairs, and random talking and typing: nearly every pair heard, nothing else.
    var missed = 0, falseWakes = 0
    let pick = ClapScene(rate: 8000, secs: 0, seed: 99)
    func u(_ a: Double, _ b: Double) -> Double { a + (b - a) * (pick.rnd() + 1) / 2 }
    for k in 0 ..< 150 {
        let rate = [16000.0, 44100, 48000][k % 3]
        let s = ClapScene(rate: rate, secs: 4, seed: UInt32(k + 7))
        let t = u(0.6, 2), gap = u(0.18, 0.75), a = u(0.1, 0.8)
        s.clap(t, a, reverb: u(0, 0.15)); s.clap(t + gap, a * u(0.6, 1.4), reverb: u(0, 0.15))
        if s.doubleClaps(chunk: [256, 512, 1024, 4096][k % 4]) != 1 { missed += 1 }
        let o = ClapScene(rate: rate, secs: 4, seed: UInt32(k + 1000))
        switch k % 3 {
        case 0: o.speech(0.1, 3.9, u(0.05, 0.6))
        case 1: var tt = 0.2; while tt < 3.8 { o.tap(tt, u(0.1, 0.4)); tt += u(0.08, 0.25) }
        default: o.speech(0.1, 3.9, u(0.1, 0.4)); o.clap(u(1, 2.5))
        }
        if o.doubleClaps() != 0 { falseWakes += 1 }
    }
    print("\(missed <= 6 ? "ok" : "FAIL") random pairs: \(missed) of 150 missed (at most 6)"); if missed > 6 { bad += 1 }
    check("false wakes on random talking, typing and single claps", falseWakes, 0)
    exit(bad == 0 ? 0 : 1)
}
// --test-snap checks which drawn paths count as a circled area; exits 1 on a failure.
if args.contains("--test-snap") {
    var bad = 0
    func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
    func arc(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat, turns: CGFloat, steps: Int = 80) -> [CGPoint] {
        (0 ... steps).map { k in let a = turns * 2 * .pi * CGFloat(k) / CGFloat(steps); return CGPoint(x: cx + r * cos(a), y: cy + r * sin(a)) }
    }
    let lead = (0 ..< 20).map { CGPoint(x: 100 + CGFloat($0) * 4, y: 300) }
    check("a full circle snaps", Loop.closing(arc(300, 300, 60, turns: 1)) != nil)
    check("a circle with a run-up and overshoot snaps from where the loop starts", Loop.closing(lead + arc(200, 300, 60, turns: 1.08)).map { $0 >= lead.count - 2 } == true)
    check("three-quarters of a circle doesn't", Loop.closing(arc(300, 300, 60, turns: 0.75)) == nil)
    check("three-quarters doesn't close even at the end", Loop.closing(arc(300, 300, 60, turns: 0.75), gap: Loop.closeGap * 1.8) == nil)
    check("a nearly closed circle closes with the looser gap at the end", Loop.closing(arc(300, 300, 60, turns: 0.93), gap: Loop.closeGap * 1.8) != nil)
    check("a straight line doesn't", Loop.closing((0 ..< 80).map { CGPoint(x: CGFloat($0) * 5, y: 200) }) == nil)
    let there = (0 ..< 40).map { CGPoint(x: CGFloat($0) * 5, y: 200) }
    check("a line drawn back over itself doesn't", Loop.closing(there + there.reversed().map { CGPoint(x: $0.x, y: $0.y + 3) }) == nil)
    check("a zigzag doesn't", Loop.closing((0 ..< 60).map { CGPoint(x: CGFloat($0) * 6, y: 200 + ($0 % 2 == 0 ? 0 : 30)) }) == nil)
    check("a tiny scribble doesn't", Loop.closing(arc(300, 300, 8, turns: 3)) == nil)
    var box: [CGPoint] = stride(from: CGFloat(0), through: 120, by: 6).map { CGPoint(x: $0, y: 0) }
    box += stride(from: CGFloat(0), through: 90, by: 6).map { CGPoint(x: 120, y: $0) }
    box += stride(from: CGFloat(120), through: 0, by: -6).map { CGPoint(x: $0, y: 90) }
    box += stride(from: CGFloat(90), through: 0, by: -6).map { CGPoint(x: 2, y: $0) }
    check("a rough box snaps", Loop.closing(box) != nil)
    exit(bad == 0 ? 0 : 1)
}
// --test-chord checks when the talk chord counts as part of a shortcut, with made-up key states; exits 1 on a failure.
if args.contains("--test-chord") {
    var bad = 0
    func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
    check("the chord alone is a talk", !Voice.isShortcut(extra: false, heldAtArm: [], now: []))
    check("a key pressed with it is a shortcut (⌃⌥S)", Voice.isShortcut(extra: false, heldAtArm: [], now: [0x01]))
    check("an extra ⇧ or ⌘ is a shortcut", Voice.isShortcut(extra: true, heldAtArm: [], now: []))
    // Regression: key code 0 read as held at almost every press, though no key was, so nearly every talk was rejected.
    check("a key already down when the chord went down doesn't count", !Voice.isShortcut(extra: false, heldAtArm: [0x00], now: [0x00]))
    check("a key pressed after it still does", Voice.isShortcut(extra: false, heldAtArm: [0x00], now: [0x00, 0x01]))
    check("a held key let go isn't a key pressed", !Voice.isShortcut(extra: false, heldAtArm: [0x00], now: []))
    check("an extra ⇧ or ⌘ still counts with a key held", Voice.isShortcut(extra: true, heldAtArm: [0x00], now: [0x00]))
    exit(bad == 0 ? 0 : 1)
}
// --test-clicks: which clicks count as changing the screen, with made-up element roles; exits 1 on a failure.
if args.contains("--test-clicks") {
    var bad = 0
    func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
    check("a link in a web page", ClickTarget.acts(roles: ["AXStaticText", "AXLink", "AXGroup", "AXWebArea"], count: 1))
    check("a button", ClickTarget.acts(roles: ["AXButton", "AXToolbar", "AXWindow"], count: 1))
    check("a menu item", ClickTarget.acts(roles: ["AXMenuItem", "AXMenu"], count: 1))
    check("a tab", ClickTarget.acts(roles: ["AXRadioButton", "AXTabGroup", "AXWindow"], count: 1))
    check("plain text in a page doesn't", !ClickTarget.acts(roles: ["AXStaticText", "AXGroup", "AXWebArea", "AXScrollArea"], count: 1))
    check("one click on a list row doesn't", !ClickTarget.acts(roles: ["AXStaticText", "AXCell", "AXRow", "AXOutline"], count: 1))
    check("a double-click on a list row opens it", ClickTarget.acts(roles: ["AXStaticText", "AXCell", "AXRow", "AXOutline"], count: 2))
    check("a double-click on page text doesn't (it selects a word)", !ClickTarget.acts(roles: ["AXStaticText", "AXWebArea"], count: 2))
    check("a link inside a list still counts", ClickTarget.acts(roles: ["AXLink", "AXCell", "AXRow", "AXTable"], count: 1))
    exit(bad == 0 ? 0 : 1)
}
// --wake-file <wav>: a recording through the real recogniser (with the mic boost) and the wake matcher, as live
// listening would hear it. Prints one JSON line: whether it woke, what followed the phrase, the closest name.
if let i = args.firstIndex(of: "--wake-file"), i + 1 < args.count {
    let url = URL(fileURLWithPath: args[i + 1])
    guard let file = try? AVAudioFile(forReading: url) else { emit(["type": "wake_file", "error": "can't read \(url.path)"]); exit(2) }
    var heard = "", woke = false, closest: Int?
    let report = {
        emit(["type": "wake_file", "file": url.lastPathComponent, "woke": woke, "rest": woke ? WakeWord.match(heard) ?? "" : "", "distance": closest ?? -1, "heard": heard])
        exit(0)
    }
    let cb = RecognizerCallbacks(
        onText: { text in
            heard = text
            let (rest, d, _) = WakeWord.scan(text)
            if rest != nil { woke = true }
            if let d { closest = min(closest ?? d, d) }
        },
        onDone: { report() },
        onError: { e in log("recognition: \(e.localizedDescription)"); report() }
    )
    var r: Recognizer?
    if #available(macOS 26, *), SpeechTranscriber.isAvailable { r = AnalyzerRecognizer(cb) } else { r = LegacyRecognizer(cb) }
    guard let r else { emit(["type": "wake_file", "error": "speech recognition unavailable"]); exit(2) }
    let gain = AutoGain()
    while let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 1024), (try? file.read(into: buf)) != nil, buf.frameLength > 0 {
        if let x = buf.floatChannelData?[0] {
            var sum: Float = 0
            for k in 0 ..< Int(buf.frameLength) { sum += x[k] * x[k] }
            gain.apply(buf, rms: sqrt(sum / Float(buf.frameLength)))
        }
        r.append(buf)
    }
    r.end()
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) { report() }
    dispatchMain()
}
if args.contains("--perms") { emit(permStatus()); exit(0) }
if let i = args.firstIndex(of: "--request"), i + 1 < args.count {
    let done = DispatchSemaphore(value: 0)
    switch args[i + 1] {
    case "mic": AVCaptureDevice.requestAccess(for: .audio) { _ in done.signal() }; done.wait()
    case "speech": SFSpeechRecognizer.requestAuthorization { _ in done.signal() }; done.wait()
    case "screen": _ = CGRequestScreenCaptureAccess()
    default: break
    }
    emit(permStatus()); exit(0)
}

var signalSources: [DispatchSourceSignal] = []
let voice = Voice()
if args.contains("--no-mute") { OutputMute.enabled = false }
if let i = args.firstIndex(of: "--chord"), i + 1 < args.count { voice.setChord(args[i + 1].components(separatedBy: ",")) }
if LiveTest.url != nil { OutputMute.enabled = false; voice.setWake(true); voice.setClaps(true); LiveTest.start() }
let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { _ in voice.tick() }
RunLoop.main.add(timer, forMode: .common)
Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        switch msg["cmd"] as? String {
        case "cancel": DispatchQueue.main.async { voice.externalCancel() }
        case "listen": DispatchQueue.main.async { voice.listenNow() }
        // The sidekick is answering (it appears where the cursor is): the listening pill can go.
        case "handoff": DispatchQueue.main.async { voice.wave.hide() }
        // The sidekick following the cursor in its cursor form, drawn here (buddy.swift) until the page takes it back.
        case "buddy": DispatchQueue.main.async { if msg["on"] as? Bool == true { voice.buddy.show(msg) } else { voice.buddy.hide() } }
        case "buddy_alpha": if let a = msg["a"] as? Double { DispatchQueue.main.async { voice.buddy.setHidden(a < 0.5) } }
        case "chord": if let mods = msg["mods"] as? [String] { DispatchQueue.main.async { voice.setChord(mods) } }
        case "watch_clicks": let on = msg["on"] as? Bool == true; DispatchQueue.main.async { voice.watchClicks = on }
        case "sound": if let on = msg["on"] as? Bool { DispatchQueue.main.async { SnapCue.soundOn = on } }
        case "wake": if let on = msg["on"] as? Bool { DispatchQueue.main.async { voice.setWake(on) } }
        case "claps": if let on = msg["on"] as? Bool { DispatchQueue.main.async { voice.setClaps(on) } }
        // The name after "Hey" (empty: Roamies). Only whether it's custom is logged, never the word.
        case "wake_name":
            let word = msg["word"] as? String ?? ""
            DispatchQueue.main.async { log(WakeWord.setName(word) ? "wake name: \(WakeWord.custom == nil ? "Roamies" : "custom")" : "wake name refused") }
        // Roamies is answering or speaking: don't listen for the phrase (it mustn't wake itself).
        case "wake_hold": let on = msg["on"] as? Bool == true; DispatchQueue.main.async { voice.wakeHold = on }
        case "mute": if let on = msg["on"] as? Bool { DispatchQueue.main.async { OutputMute.enabled = on; if !on { OutputMute.end() } } }
        default: break
        }
    }
    // Roamies quit: never leave the Mac muted.
    DispatchQueue.main.sync { OutputMute.end() }
    exit(0)
}
// Killed (Quit, crash restart): restore output on the way out too.
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { OutputMute.end(); exit(0) }
    src.resume()
    signalSources.append(src)
}
emit(["type": "ready", "engine": voice.engineName, "dryRun": dryRun])
// An app run loop (no Dock icon) so the drawing panels get mouse events.
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
