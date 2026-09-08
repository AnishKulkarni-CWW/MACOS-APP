import Vision
import AppKit
import Foundation

// Usage: ocr-vision /path/to/image.jpg
// Outputs JSON with recognized text lines and confidence scores.
// Language correction is DISABLED to preserve misspellings for QA spell checking.

guard CommandLine.arguments.count > 1 else {
    let error: [String: Any] = ["success": false, "error": "No image path provided"]
    if let data = try? JSONSerialization.data(withJSONObject: error),
       let str = String(data: data, encoding: .utf8) { print(str) }
    exit(1)
}

let imagePath = CommandLine.arguments[1]

guard let image = NSImage(contentsOfFile: imagePath) else {
    let error: [String: Any] = ["success": false, "error": "Could not load image at: \(imagePath)"]
    if let data = try? JSONSerialization.data(withJSONObject: error),
       let str = String(data: data, encoding: .utf8) { print(str) }
    exit(1)
}

guard let tiffData = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiffData),
      let cgImage = bitmap.cgImage else {
    let error: [String: Any] = ["success": false, "error": "Could not create CGImage"]
    if let data = try? JSONSerialization.data(withJSONObject: error),
       let str = String(data: data, encoding: .utf8) { print(str) }
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate

// IMPORTANT: Disable language correction so misspellings are preserved
// for downstream spell checking. If enabled, Vision auto-corrects
// "posible" → "possible", defeating QA detection.
request.usesLanguageCorrection = false

// Detect the smallest possible text (disclaimers, footnotes)
request.minimumTextHeight = 0.0

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try handler.perform([request])
} catch {
    let errorObj: [String: Any] = ["success": false, "error": error.localizedDescription]
    if let data = try? JSONSerialization.data(withJSONObject: errorObj),
       let str = String(data: data, encoding: .utf8) { print(str) }
    exit(1)
}

var lines: [[String: Any]] = []
let observations = request.results ?? []

for observation in observations {
    if let candidate = observation.topCandidates(1).first {
        let line: [String: Any] = [
            "text": candidate.string,
            "confidence": Double(candidate.confidence)
        ]
        lines.append(line)
    }
}

let output: [String: Any] = [
    "success": true,
    "lines": lines
]

if let jsonData = try? JSONSerialization.data(withJSONObject: output),
   let jsonString = String(data: jsonData, encoding: .utf8) {
    print(jsonString)
}
