import ExpoModulesCore
import SpotifyiOS
import UIKit

// Now playing + playback controls for the Spotify app (Spotify's App Remote
// SDK). Spotify does the playing; tarmacked only shows what's on and sends
// play / pause / skip. iOS drops the link while tarmacked is in the
// background, so the app reconnects whenever it's opened.
//
// Sign-in: authorize() opens Spotify, which asks once for permission and
// comes back to tarmacked://spotify-callback with a token (handleURL).
// The token lasts about an hour; after that, connect() fails and the app
// offers "Reconnect" (a quick hop to Spotify and back).

final class SpotifyBridge: NSObject, SPTAppRemoteDelegate, SPTAppRemotePlayerStateDelegate {
  static let tokenKey = "tarmacked.spotify.token"
  var remote: SPTAppRemote?
  var send: (([String: Any?]) -> Void)?
  private var lastImageId: String?

  func configure(clientID: String, redirect: String) {
    guard remote == nil, let url = URL(string: redirect) else { return }
    let configuration = SPTConfiguration(clientID: clientID, redirectURL: url)
    let r = SPTAppRemote(configuration: configuration, logLevel: .error)
    r.delegate = self
    if let token = UserDefaults.standard.string(forKey: SpotifyBridge.tokenKey) {
      r.connectionParameters.accessToken = token
    }
    remote = r
  }

  var hasToken: Bool {
    return remote?.connectionParameters.accessToken != nil
  }

  // MARK: SPTAppRemoteDelegate

  func appRemoteDidEstablishConnection(_ appRemote: SPTAppRemote) {
    send?(["connected": true])
    appRemote.playerAPI?.delegate = self
    appRemote.playerAPI?.subscribe(toPlayerState: { _, error in
      if let error = error {
        self.send?(["connected": true, "error": error.localizedDescription])
      }
    })
    appRemote.playerAPI?.getPlayerState { result, _ in
      if let state = result as? SPTAppRemotePlayerState {
        self.playerStateDidChange(state)
      }
    }
  }

  func appRemote(_ appRemote: SPTAppRemote, didFailConnectionAttemptWithError error: Error?) {
    send?(["connected": false, "error": error?.localizedDescription ?? "Couldn't connect to Spotify"])
  }

  func appRemote(_ appRemote: SPTAppRemote, didDisconnectWithError error: Error?) {
    send?(["connected": false])
  }

  // MARK: SPTAppRemotePlayerStateDelegate

  func playerStateDidChange(_ playerState: SPTAppRemotePlayerState) {
    let track = playerState.track
    send?([
      "connected": true,
      "track": track.name,
      "artist": track.artist.name,
      "album": track.album.name,
      "paused": playerState.isPaused,
      "imageId": track.imageIdentifier,
    ])
    let imageId = track.imageIdentifier
    if imageId == lastImageId { return }
    lastImageId = imageId
    remote?.imageAPI?.fetchImage(forItem: track, with: CGSize(width: 120, height: 120), callback: { result, _ in
      guard let image = result as? UIImage, let data = image.jpegData(compressionQuality: 0.8) else { return }
      self.send?(["imageId": imageId, "image": "data:image/jpeg;base64," + data.base64EncodedString()])
    })
  }
}

public class SpotifyRemoteModule: Module {
  private let bridge = SpotifyBridge()

  public func definition() -> ModuleDefinition {
    Name("SpotifyRemote")

    // State changes: { connected, track, artist, album, paused, imageId, image, error } (partial).
    Events("onState")

    OnCreate {
      self.bridge.send = { [weak self] body in
        self?.sendEvent("onState", body)
      }
    }

    AsyncFunction("configure") { (clientID: String, redirect: String) -> Bool in
      self.bridge.configure(clientID: clientID, redirect: redirect)
      return self.bridge.hasToken
    }.runOnQueue(.main)

    // Opens Spotify to sign in (and start playing where you left off).
    // Resolves false if Spotify isn't installed.
    AsyncFunction("authorize") { (promise: Promise) in
      guard let remote = self.bridge.remote else {
        promise.reject("E_SPOTIFY", "Not configured")
        return
      }
      remote.authorizeAndPlayURI("") { installed in
        promise.resolve(installed)
      }
    }.runOnQueue(.main)

    // The tarmacked://spotify-callback link Spotify opened us with.
    // Returns "ok", an error message, or "" if it wasn't Spotify's.
    AsyncFunction("handleURL") { (urlString: String) -> String in
      guard let remote = self.bridge.remote, let url = URL(string: urlString) else { return "" }
      guard let params = remote.authorizationParameters(from: url) else { return "" }
      if let token = params[SPTAppRemoteAccessTokenKey] {
        remote.connectionParameters.accessToken = token
        UserDefaults.standard.set(token, forKey: SpotifyBridge.tokenKey)
        remote.connect()
        return "ok"
      }
      return params[SPTAppRemoteErrorDescriptionKey] ?? "Spotify sign-in failed"
    }.runOnQueue(.main)

    // Reconnects with the saved sign-in (Spotify must be running, e.g. playing).
    AsyncFunction("connect") { () -> Bool in
      guard let remote = self.bridge.remote, self.bridge.hasToken else { return false }
      if !remote.isConnected { remote.connect() }
      return true
    }.runOnQueue(.main)

    AsyncFunction("disconnect") { () -> Void in
      if let remote = self.bridge.remote, remote.isConnected { remote.disconnect() }
    }.runOnQueue(.main)

    AsyncFunction("signOut") { () -> Void in
      if let remote = self.bridge.remote {
        if remote.isConnected { remote.disconnect() }
        remote.connectionParameters.accessToken = nil
      }
      UserDefaults.standard.removeObject(forKey: SpotifyBridge.tokenKey)
    }.runOnQueue(.main)

    AsyncFunction("play") { () -> Void in
      self.bridge.remote?.playerAPI?.resume(nil)
    }.runOnQueue(.main)

    AsyncFunction("pause") { () -> Void in
      self.bridge.remote?.playerAPI?.pause(nil)
    }.runOnQueue(.main)

    AsyncFunction("next") { () -> Void in
      self.bridge.remote?.playerAPI?.skip(toNext: nil)
    }.runOnQueue(.main)

    AsyncFunction("previous") { () -> Void in
      self.bridge.remote?.playerAPI?.skip(toPrevious: nil)
    }.runOnQueue(.main)
  }
}
