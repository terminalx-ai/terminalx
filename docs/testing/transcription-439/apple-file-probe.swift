import Foundation
import Speech
let status = SFSpeechRecognizer.authorizationStatus()
let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
let report: [String: Any] = ["authorizationStatus": status.rawValue, "available": recognizer?.isAvailable ?? false, "supportsOnDeviceRecognition": recognizer?.supportsOnDeviceRecognition ?? false, "path": "SFSpeechURLRecognitionRequest", "microphoneOpened": false]
print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
guard status == .authorized else { print("BLOCKED: speech recognition authorization is not granted; no permission request, file recognition or microphone capture started."); exit(3) }
guard let recognizer = recognizer, recognizer.supportsOnDeviceRecognition else { print("BLOCKED: on-device en-US recognition unavailable."); exit(4) }
let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: CommandLine.arguments[1]))
request.requiresOnDeviceRecognition = true
request.shouldReportPartialResults = false
request.contextualStrings = Array(CommandLine.arguments.dropFirst(2))
var done = false
var failed = false
let task = recognizer.recognitionTask(with: request) { result, error in
 if let error = error { print("ERROR: \(error)"); failed = true; done = true }
 if let result = result, result.isFinal { print("FINAL: \(result.bestTranscription.formattedString)"); done = true }
}
let deadline = Date().addingTimeInterval(30)
while !done && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
if !done { task.cancel(); print("ERROR: file recognition timeout"); exit(5) }

if failed { exit(2) }
