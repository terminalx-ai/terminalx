// Typecheck-only stand-in for the exact upstream exposed handle members.
// Never compiled into the candidate patch or executed by the fixture process.
import Foundation
import Virtualization
@MainActor final class DarwinVirtualizationService {
    final class VirtualMachineHandle: @unchecked Sendable {
        let machine: VZVirtualMachine
        let queue: DispatchQueue
        init(machine: VZVirtualMachine, queue: DispatchQueue) {
            self.machine = machine; self.queue = queue
        }
    }
    var virtualMachineHandle: VirtualMachineHandle { fatalError("typecheck only") }
}
