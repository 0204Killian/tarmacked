import ExpoModulesCore
import CoreMotion

// iOS motion activity: what the phone thinks you're doing (in a vehicle,
// walking, stationary...), as recorded by the motion coprocessor. It keeps
// a history, so the app can ask what happened while it was closed.
public class MotionActivityModule: Module {
  private let manager = CMMotionActivityManager()

  static func statusString() -> String {
    switch CMMotionActivityManager.authorizationStatus() {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
  }

  public func definition() -> ModuleDefinition {
    Name("MotionActivity")

    Function("isAvailable") { () -> Bool in
      return CMMotionActivityManager.isActivityAvailable()
    }

    Function("authorizationStatus") { () -> String in
      return MotionActivityModule.statusString()
    }

    // Shows the Motion & Fitness prompt (if it hasn't been answered yet) by
    // briefly starting live activity updates — the way iOS reliably asks —
    // then waits up to a minute for the answer. Resolves with the status.
    AsyncFunction("requestPermission") { (promise: Promise) in
      guard CMMotionActivityManager.isActivityAvailable() else {
        promise.resolve("unavailable")
        return
      }
      if CMMotionActivityManager.authorizationStatus() != .notDetermined {
        promise.resolve(MotionActivityModule.statusString())
        return
      }
      let manager = self.manager
      DispatchQueue.main.async {
        manager.startActivityUpdates(to: OperationQueue.main) { _ in }
        func check(_ waited: Double) {
          if CMMotionActivityManager.authorizationStatus() != .notDetermined || waited >= 60 {
            manager.stopActivityUpdates()
            promise.resolve(MotionActivityModule.statusString())
            return
          }
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { check(waited + 0.25) }
        }
        check(0)
      }
    }

    // Activities that started between two times (milliseconds since 1970).
    // The first call asks the user for Motion & Fitness permission.
    AsyncFunction("queryActivities") { (fromMs: Double, toMs: Double, promise: Promise) in
      guard CMMotionActivityManager.isActivityAvailable() else {
        promise.resolve([])
        return
      }
      let from = Date(timeIntervalSince1970: fromMs / 1000)
      let to = Date(timeIntervalSince1970: toMs / 1000)
      let manager = self.manager
      manager.queryActivityStarting(from: from, to: to, to: OperationQueue.main) { activities, error in
        if let error = error {
          promise.reject("E_MOTION", error.localizedDescription)
          return
        }
        let out: [[String: Any]] = (activities ?? []).map { a in
          return [
            "start": a.startDate.timeIntervalSince1970 * 1000,
            "automotive": a.automotive,
            "walking": a.walking,
            "running": a.running,
            "cycling": a.cycling,
            "stationary": a.stationary,
            "unknown": a.unknown,
            "confidence": a.confidence.rawValue,
          ]
        }
        promise.resolve(out)
      }
    }
  }
}
