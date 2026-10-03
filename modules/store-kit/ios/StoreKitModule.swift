import ExpoModulesCore
import StoreKit

// tarmacked Premium (v0.21): one in-app purchase, bought once, kept for
// good, through Apple (StoreKit 2). No accounts and no server of ours:
// Apple's own signed receipts on the phone say whether it's been bought.

public class StoreKitModule: Module {
  private var updates: Task<Void, Never>?

  // Whether the phone holds a valid (not refunded) purchase of this product.
  static func owns(_ id: String) async -> Bool {
    for await result in Transaction.currentEntitlements {
      if case .verified(let t) = result, t.productID == id, t.revocationDate == nil {
        return true
      }
    }
    return false
  }

  public func definition() -> ModuleDefinition {
    Name("TarmackedStore")

    // Purchases finished elsewhere (Ask to Buy, another device, a refund)
    // arrive here; each is acknowledged so Apple stops resending it.
    OnCreate {
      self.updates = Task.detached {
        for await result in Transaction.updates {
          if case .verified(let t) = result {
            await t.finish()
          }
        }
      }
    }

    OnDestroy {
      self.updates?.cancel()
    }

    // The product as the App Store shows it here (price in the local currency).
    AsyncFunction("product") { (id: String) async throws -> [String: Any]? in
      guard let p = try await Product.products(for: [id]).first else { return nil }
      return ["id": p.id, "title": p.displayName, "price": p.displayPrice]
    }

    // Apple's purchase sheet. "purchased", "cancelled", "pending" (waiting
    // on Ask to Buy), "unavailable" or "failed".
    AsyncFunction("purchase") { (id: String) async throws -> String in
      guard let p = try await Product.products(for: [id]).first else { return "unavailable" }
      let result = try await p.purchase()
      switch result {
      case .success(let verification):
        if case .verified(let t) = verification {
          await t.finish()
          return "purchased"
        }
        return "failed"
      case .userCancelled:
        return "cancelled"
      case .pending:
        return "pending"
      @unknown default:
        return "failed"
      }
    }

    AsyncFunction("owned") { (id: String) async -> Bool in
      return await StoreKitModule.owns(id)
    }

    // "Restore purchase": asks Apple to bring this Apple ID's purchases to
    // the phone (may ask the person to sign in), then checks again.
    AsyncFunction("restore") { (id: String) async throws -> Bool in
      try await AppStore.sync()
      return await StoreKitModule.owns(id)
    }
  }
}
