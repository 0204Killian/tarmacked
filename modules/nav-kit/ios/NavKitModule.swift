import ExpoModulesCore
import AVFoundation
import MapKit
import CoreLocation

// For tarmacked's own sat-nav (v0.18): spoken prompts on the phone (no
// network), lowering other audio (music) while they play; and Apple's
// place search and place names, for picking where to go (online). The
// routes themselves are worked out by tarmacked (src/router.ts).

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
  private let geocoder = CLGeocoder()
  private var activeSearch: MKLocalSearch?

  // "12 Main Street, Kilkenny, R95 X2K4"
  static func address(_ pm: MKPlacemark) -> String {
    var parts: [String] = []
    if let street = pm.thoroughfare {
      if let number = pm.subThoroughfare {
        parts.append("\(number) \(street)")
      } else {
        parts.append(street)
      }
    }
    if let town = pm.locality { parts.append(town) }
    if let code = pm.postalCode { parts.append(code) }
    return parts.joined(separator: ", ")
  }

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

    // Places, addresses and businesses matching what's typed, nearest to
    // (lat, lon) first when given (0, 0 = no position). Needs a connection.
    AsyncFunction("search") { (query: String, lat: Double, lon: Double, promise: Promise) in
      let request = MKLocalSearch.Request()
      request.naturalLanguageQuery = query
      request.resultTypes = [.address, .pointOfInterest]
      if lat != 0 || lon != 0 {
        request.region = MKCoordinateRegion(
          center: CLLocationCoordinate2D(latitude: lat, longitude: lon),
          latitudinalMeters: 150_000,
          longitudinalMeters: 150_000
        )
      }
      self.activeSearch?.cancel()
      let search = MKLocalSearch(request: request)
      self.activeSearch = search
      search.start { response, error in
        if let error = error {
          if let mk = error as? MKError, mk.code == .placemarkNotFound {
            promise.resolve([])
          } else {
            promise.reject("E_SEARCH", error.localizedDescription)
          }
          return
        }
        var out: [[String: Any]] = []
        for item in (response?.mapItems ?? []).prefix(15) {
          let pm = item.placemark
          out.append([
            "name": item.name ?? pm.title ?? query,
            "subtitle": NavKitModule.address(pm),
            "lat": pm.coordinate.latitude,
            "lon": pm.coordinate.longitude,
          ])
        }
        promise.resolve(out)
      }
    }.runOnQueue(.main)

    // A short name for a spot on the map ("12 Main Street, Kilkenny"), or "".
    AsyncFunction("placeName") { (lat: Double, lon: Double, promise: Promise) in
      self.geocoder.cancelGeocode()
      self.geocoder.reverseGeocodeLocation(CLLocation(latitude: lat, longitude: lon)) { placemarks, _ in
        guard let pm = placemarks?.first else {
          promise.resolve("")
          return
        }
        var parts: [String] = []
        if let street = pm.thoroughfare {
          if let number = pm.subThoroughfare {
            parts.append("\(number) \(street)")
          } else {
            parts.append(street)
          }
        } else if let name = pm.name {
          parts.append(name)
        }
        if let town = pm.locality { parts.append(town) }
        promise.resolve(parts.joined(separator: ", "))
      }
    }.runOnQueue(.main)
  }
}
