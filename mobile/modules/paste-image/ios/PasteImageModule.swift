import ExpoModulesCore
import ObjectiveC
import UIKit

/// React Native's text view takes only text: an image on the pasteboard
/// offers no Paste, and a pasted one is dropped. This teaches that view
/// (`RCTUITextView`, nothing else) to offer Paste for an image and hand the
/// image to JavaScript as `onPasteImage`, as JPEG. Text pastes as before.
public class PasteImageModule: Module {
  fileprivate static weak var current: PasteImageModule?

  public func definition() -> ModuleDefinition {
    Name("PasteImage")
    Events("onPasteImage")

    OnCreate {
      PasteImageModule.current = self
      DispatchQueue.main.async { PasteImageInstaller.install() }
    }
  }

  fileprivate static func emit(_ image: UIImage) {
    guard let data = image.jpegData(compressionQuality: 0.8) else { return }
    current?.sendEvent("onPasteImage", [
      "data": data.base64EncodedString(),
      "width": image.size.width * image.scale,
      "height": image.size.height * image.scale,
    ])
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
            DispatchQueue.main.async { PasteImageModule.emit(image) }
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
