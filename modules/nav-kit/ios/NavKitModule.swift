import ExpoModulesCore
import AVFoundation

// Spoken prompts on the phone (no network), lowering other audio (music)
// while they play. Kept for tarmacked's own sat-nav (0.18); the route logic
// is in src/nav.ts. Apple's search and directions were removed in 0.17.

// Lets other audio come back to full volume once a prompt has been spoken.
final class NavSpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    NavKitModule.endDucking(synthesizer)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    NavKitModule.endDucking(synthesizer)
  }
}

public class NavKitModule: Module {
  private let synth = AVSpeechSynthesizer()
  private let speechDelegate = NavSpeechDelegate()

  static func endDucking(_ synthesizer: AVSpeechSynthesizer) {
    if synthesizer.isSpeaking { return }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  public func definition() -> ModuleDefinition {
    Name("NavKit")

    OnCreate {
      self.synth.delegate = self.speechDelegate
    }

    // Speaks a prompt, lowering other audio (music) while it plays and
    // pausing spoken audio (podcasts).
    AsyncFunction("speak") { (text: String) -> Void in
      let session = AVAudioSession.sharedInstance()
      try? session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
      try? session.setActive(true)
      let utterance = AVSpeechUtterance(string: text)
      utterance.voice = AVSpeechSynthesisVoice(language: "en-IE") ?? AVSpeechSynthesisVoice(language: "en-GB")
      self.synth.speak(utterance)
    }.runOnQueue(.main)

    AsyncFunction("stopSpeaking") { () -> Void in
      _ = self.synth.stopSpeaking(at: .immediate)
    }.runOnQueue(.main)
  }
}
