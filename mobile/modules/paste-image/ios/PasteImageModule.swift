import ExpoModulesCore
import ObjectiveC
import UIKit

/// React Native's text view takes only text: an image on the pasteboard
/// offers no Paste, and a pasted one is dropped. This teaches that view
/// (`RCTUITextView`, nothing else) to offer Paste for an image and hand the
/// image to JavaScript as `onPasteImage`, as JPEG. Text pastes as before.
public class PasteImageModule: Module {
  fileprivate static weak var current: PasteImageModule?
  private static let maxEdge: CGFloat = 2048
  private static let encodeQueue = DispatchQueue.global(qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("PasteImage")
    Events("onPasteImage")

    OnCreate {
      PasteImageModule.current = self
      DispatchQueue.main.async { PasteImageInstaller.install() }
    }
  }

  /// Downscales and JPEG-encodes pasted images off the main thread and hands JavaScript
  /// a temporary file URI instead of raw Base64 over the bridge (P-78).
  fileprivate static func emit(_ image: UIImage) {
    encodeQueue.async {
      let prepared = downscaleIfNeeded(image, maxEdge: maxEdge)
      guard let data = prepared.jpegData(compressionQuality: 0.8) else { return }
      let fileURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("paste-\(UUID().uuidString).jpg")
      do {
        try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      } catch {
        return
      }
      let width = Int((prepared.size.width * prepared.scale).rounded())
      let height = Int((prepared.size.height * prepared.scale).rounded())
      DispatchQueue.main.async {
        current?.sendEvent("onPasteImage", [
          "uri": fileURL.absoluteString,
          "width": width,
          "height": height,
        ])
      }
    }
  }

  private static func downscaleIfNeeded(_ image: UIImage, maxEdge: CGFloat) -> UIImage {
    let pixelWidth = image.size.width * image.scale
    let pixelHeight = image.size.height * image.scale
    let longest = max(pixelWidth, pixelHeight)
    guard longest > 0 else { return image }
    if longest <= maxEdge && image.imageOrientation == .up {
      return image
    }
    let ratio = longest > maxEdge ? maxEdge / longest : 1.0
    let targetSize = CGSize(width: max(1, (pixelWidth * ratio).rounded()), height: max(1, (pixelHeight * ratio).rounded()))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1.0
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
    return renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: targetSize))
    }
  }
}

private enum PasteImageInstaller {
  private static var installed = false

  static func install() {
    guard !installed, let textView = NSClassFromString("RCTUITextView") else { return }
    installed = true
    offerPaste(on: textView)
    takePaste(on: textView)
    takePastedItems(on: textView)
    acceptPastedItems(on: textView)
  }

  /// Replaces `selector` on `cls` alone: added to the class when only a superclass has it, so UITextView elsewhere is untouched.
  private static func replace(_ cls: AnyClass, _ selector: Selector, _ make: (IMP?) -> Any) {
    let method = class_getInstanceMethod(cls, selector)
    let original = method.map(method_getImplementation)
    let replacement = imp_implementationWithBlock(make(original))
    let types = method.flatMap { method_getTypeEncoding($0) }
    if !class_addMethod(cls, selector, replacement, types), let method {
      method_setImplementation(method, replacement)
    }
  }

  private static func onlyImage(_ board: UIPasteboard) -> Bool { board.hasImages && !board.hasStrings && !board.hasURLs }

  /// Paste in the edit menu while the pasteboard holds an image.
  private static func offerPaste(on cls: AnyClass) {
    let selector = #selector(UIResponder.canPerformAction(_:withSender:))
    replace(cls, selector) { original in
      typealias Call = @convention(c) (AnyObject, Selector, Selector, Any?) -> Bool
      let call = original.map { unsafeBitCast($0, to: Call.self) }
      let block: @convention(block) (AnyObject, Selector, Any?) -> Bool = { view, action, sender in
        if action == #selector(UIResponderStandardEditActions.paste(_:)), onlyImage(UIPasteboard.general), (view as? UITextView)?.isEditable == true {
          return true
        }
        return call?(view, selector, action, sender) ?? false
      }
      return block
    }
  }

  /// Paste of an image goes to JavaScript instead of nowhere.
  private static func takePaste(on cls: AnyClass) {
    let selector = #selector(UIResponderStandardEditActions.paste(_:))
    replace(cls, selector) { original in
      typealias Call = @convention(c) (AnyObject, Selector, Any?) -> Void
      let call = original.map { unsafeBitCast($0, to: Call.self) }
      let block: @convention(block) (AnyObject, Any?) -> Void = { view, sender in
        let board = UIPasteboard.general
        if onlyImage(board), let image = board.image {
          PasteImageModule.emit(image)
          return
        }
        call?(view, selector, sender)
      }
      return block
    }
  }

  /// Pastes that arrive as item providers (keyboard paste suggestions among them): an image goes to JavaScript.
  private static func takePastedItems(on cls: AnyClass) {
    let selector = #selector(UIResponder.paste(itemProviders:))
    replace(cls, selector) { original in
      typealias Call = @convention(c) (AnyObject, Selector, NSArray) -> Void
      let call = original.map { unsafeBitCast($0, to: Call.self) }
      let block: @convention(block) (AnyObject, NSArray) -> Void = { view, items in
        let providers = items.compactMap { $0 as? NSItemProvider }
        let text = providers.contains { $0.canLoadObject(ofClass: NSString.self) }
        if !text, let provider = providers.first(where: { $0.canLoadObject(ofClass: UIImage.self) }) {
          provider.loadObject(ofClass: UIImage.self) { object, _ in
            guard let image = object as? UIImage else { return }
            PasteImageModule.emit(image)
          }
          return
        }
        call?(view, selector, items)
      }
      return block
    }
  }

  /// Says the view takes images, so the system offers them.
  private static func acceptPastedItems(on cls: AnyClass) {
    let selector = #selector(UIResponder.canPaste(_:))
    replace(cls, selector) { original in
      typealias Call = @convention(c) (AnyObject, Selector, NSArray) -> Bool
      let call = original.map { unsafeBitCast($0, to: Call.self) }
      let block: @convention(block) (AnyObject, NSArray) -> Bool = { view, items in
        if items.contains(where: { ($0 as? NSItemProvider)?.canLoadObject(ofClass: UIImage.self) == true }) { return true }
        return call?(view, selector, items) ?? false
      }
      return block
    }
  }
}
