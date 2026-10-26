// dictate — on-device dictation using Apple's macOS 26 SpeechAnalyzer / DictationTranscriber.
//
// Usage:
//   dictate locales                 list supported + installed locales
//   dictate install [--locale XX]   download the on-device model for a locale
//   dictate listen [--locale XX] [--max-seconds N] [--volatile]
//
// `listen` records from the default input device and writes the final transcript
// to stdout (single line). Progress/partials go to stderr. SIGINT/SIGTERM stop
// recording gracefully, finalize the model, and exit 0.

import AVFoundation
import Foundation
import Speech

// MARK: - helpers

func err(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

func die(_ message: String, code: Int32 = 1) -> Never {
    err("error: \(message)")
    exit(code)
}

func out(_ message: String) {
    FileHandle.standardOutput.write((message + "\n").data(using: .utf8)!)
}

final class Box: @unchecked Sendable {
    private let lock = NSLock()
    private var value = ""
    func append(_ s: String) {
        lock.lock(); defer { lock.unlock() }
        if !value.isEmpty && !s.isEmpty { value += " " }
        value += s
    }
    func set(_ s: String) {
        lock.lock(); defer { lock.unlock() }
        value = s
    }
    func get() -> String {
        lock.lock(); defer { lock.unlock() }
        return value
    }
}

final class LockedDouble: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double = 0
    func set(_ v: Double) {
        lock.lock(); defer { lock.unlock() }
        value = v
    }
    func get() -> Double {
        lock.lock(); defer { lock.unlock() }
        return value
    }
}

// MARK: - args

var localeID = ProcessInfo.processInfo.environment["DICTATE_LOCALE"] ?? "en-US"
var maxSeconds: Double = 0
var showVolatile = false
var streamPath: String? = nil
var silenceStop: Double = 0
var levelPath: String? = nil
var jsonOutput = false
let levelBox = LockedDouble()

var argv = Array(CommandLine.arguments.dropFirst())
var command = "listen"
if let first = argv.first, !first.hasPrefix("-") {
    command = first
    argv.removeFirst()
}

while let a = argv.first {
    argv.removeFirst()
    switch a {
    case "--locale", "-l":
        if let v = argv.first { localeID = v; argv.removeFirst() }
    case "--max-seconds", "-t":
        if let v = argv.first { maxSeconds = Double(v) ?? 0; argv.removeFirst() }
    case "--volatile":
        showVolatile = true
    case "--stream":
        if let v = argv.first { streamPath = v; argv.removeFirst() }
    case "--silence-stop":
        if let v = argv.first { silenceStop = Double(v) ?? 0; argv.removeFirst() }
    case "--level":
        if let v = argv.first { levelPath = v; argv.removeFirst() }
    case "--json":
        jsonOutput = true
    case "--help", "-h":
        out("""
        dictate locales                 list supported + installed locales
        dictate install [--locale XX]   download the on-device model for a locale
        dictate listen [--locale XX] [--max-seconds N] [--volatile]
                       [--stream PATH] [--silence-stop SECONDS] [--level PATH]

          --stream PATH          write the live transcript to PATH after every update
          --silence-stop SECONDS finish automatically after SECONDS of no new speech
          --level PATH         write a 0..1 input loudness value to PATH
        """)
        exit(0)
    default:
        break
    }
}

func makeTranscriber(for locale: Locale) -> DictationTranscriber {
    DictationTranscriber(
        locale: locale,
        contentHints: [.shortForm],
        transcriptionOptions: [.punctuation],
        reportingOptions: [.volatileResults, .frequentFinalization],
        attributeOptions: []
    )
}

// MARK: - commands

switch command {
case "locales":
    let supported = await DictationTranscriber.supportedLocales
    let installed = await DictationTranscriber.installedLocales
    let installedIDs = Set(installed.map { $0.identifier(.bcp47) })
    if jsonOutput {
        let payload: [String: Any] = [
            "supported": supported.map { $0.identifier(.bcp47) }.sorted(),
            "installed": installed.map { $0.identifier(.bcp47) }.sorted(),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
            out(text)
        }
        exit(0)
    }
    out("supported (\(supported.count)):")
    for l in supported.map({ $0.identifier(.bcp47) }).sorted() {
        out((installedIDs.contains(l) ? "  ✓ " : "    ") + l)
    }
    out("installed (\(installed.count)): " + installed.map { $0.identifier(.bcp47) }.sorted().joined(separator: ", "))
    exit(0)

case "install":
    let want = Locale(identifier: localeID)
    guard let locale = await DictationTranscriber.supportedLocale(equivalentTo: want) else {
        die("locale \(localeID) is not supported by DictationTranscriber")
    }
    let transcriber = makeTranscriber(for: locale)
    let status = await AssetInventory.status(forModules: [transcriber])
    if status == .installed {
        out("already installed: \(locale.identifier(.bcp47))")
        exit(0)
    }
    if status == .unsupported {
        die("locale \(localeID) reports unsupported")
    }
    guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
        die("no installation request available for \(localeID)")
    }
    err("downloading model for \(locale.identifier(.bcp47)) …")
    try await request.downloadAndInstall()
    out("installed: \(locale.identifier(.bcp47))")
    exit(0)

case "listen":
    let want = Locale(identifier: localeID)
    guard let locale = await DictationTranscriber.supportedLocale(equivalentTo: want) else {
        die("locale \(localeID) is not supported; run `dictate locales`")
    }

    let transcriber = makeTranscriber(for: locale)

    let status = await AssetInventory.status(forModules: [transcriber])
    if status != .installed {
        if status == .unsupported { die("locale \(localeID) unsupported") }
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
            die("model for \(localeID) is not installed and cannot be downloaded automatically")
        }
        err("downloading model for \(locale.identifier(.bcp47)) …")
        try await request.downloadAndInstall()
    }

    guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        die("no compatible audio format for the dictation model")
    }

    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    let hwFormat = inputNode.outputFormat(forBus: 0)
    guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
        die("no usable microphone input (check System Settings → Privacy & Security → Microphone)")
    }
    guard let converter = AVAudioConverter(from: hwFormat, to: analyzerFormat) else {
        die("cannot convert \(hwFormat) → \(analyzerFormat)")
    }

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingNewest(128))
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    try await analyzer.prepareToAnalyze(in: analyzerFormat)

    let finals = Box()
    let volatile = Box()
    let lastActivity = LockedDouble()

    let (stopStream, stopContinuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))

    let resultsTask = Task {
        do {
            for try await result in transcriber.results {
                let text = String(result.text.characters)
                if result.isFinal {
                    finals.append(text)
                    volatile.set("")
                } else {
                    volatile.set(text)
                }
                let snapshot = (finals.get() + volatile.get()).trimmingCharacters(in: .whitespacesAndNewlines)
                if let path = streamPath {
                    try? snapshot.write(toFile: path, atomically: true, encoding: .utf8)
                }
                if !snapshot.isEmpty { lastActivity.set(Date().timeIntervalSince1970) }
            }
        } catch {
            err("results error: \(error)")
        }
    }

    inputNode.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { buffer, _ in
        if let levelPath, let channel = buffer.floatChannelData?[0] {
            let frames = Int(buffer.frameLength)
            if frames > 0 {
                var sum: Double = 0
                var index = 0
                while index < frames {
                    let sample = Double(channel[index])
                    sum += sample * sample
                    index += 4
                }
                let rms = (sum / Double(max(1, frames / 4))).squareRoot()
                let raw = min(1.0, rms * 7.0)
                let previous = levelBox.get()
                let smoothed = raw > previous ? raw : previous * 0.80
                levelBox.set(smoothed)
                try? String(format: "%.3f", smoothed)
                    .write(toFile: levelPath, atomically: false, encoding: .utf8)
            }
        }
        let ratio = analyzerFormat.sampleRate / hwFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let converted = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { return }
        var conversionError: NSError?
        var supplied = false
        converter.convert(to: converted, error: &conversionError) { _, statusPtr in
            if supplied {
                statusPtr.pointee = .noDataNow
                return nil
            }
            supplied = true
            statusPtr.pointee = .haveData
            return buffer
        }
        if conversionError == nil, converted.frameLength > 0 {
            continuation.yield(AnalyzerInput(buffer: converted))
        }
    }

    engine.prepare()
    try engine.start()

    let analysisTask = Task {
        do {
            try await analyzer.start(inputSequence: stream)
        } catch {
            err("analysis error: \(error)")
        }
    }

    // Stop conditions: signal, --max-seconds deadline, or silence.
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    signal(SIGHUP, SIG_IGN)
    let sources = [SIGINT, SIGTERM, SIGHUP].map { sig -> DispatchSourceSignal in
        let s = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        s.setEventHandler { stopContinuation.yield(()) }
        s.resume()
        return s
    }
    _ = sources

    err("listening (\(locale.identifier(.bcp47))) …")

    if maxSeconds > 0 {
        Task {
            try? await Task.sleep(nanoseconds: UInt64(maxSeconds * 1_000_000_000))
            stopContinuation.yield(())
        }
    }
    if silenceStop > 0 {
        Task {
            let started = Date().timeIntervalSince1970
            while true {
                try? await Task.sleep(nanoseconds: 200_000_000)
                let now = Date().timeIntervalSince1970
                let last = lastActivity.get()
                if last == 0 {
                    // Nothing heard at all yet: give the user a grace window.
                    if now - started >= max(silenceStop * 4, 8) {
                        stopContinuation.yield(())
                        return
                    }
                    continue
                }
                if now - last >= silenceStop {
                    stopContinuation.yield(())
                    return
                }
            }
        }
    }
    for await _ in stopStream { break }

    engine.stop()
    inputNode.removeTap(onBus: 0)
    continuation.finish()

    _ = await analysisTask.result
    do { try await analyzer.finalizeAndFinishThroughEndOfInput() } catch { err("finalize: \(error)") }
    _ = await resultsTask.result

    let text = finals.get().trimmingCharacters(in: .whitespacesAndNewlines)
    out(text)
    exit(0)

default:
    die("unknown command \(command); try `dictate --help`")
}
