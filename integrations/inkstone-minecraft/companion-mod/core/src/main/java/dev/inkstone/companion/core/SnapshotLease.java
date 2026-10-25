package dev.inkstone.companion.core;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

public final class SnapshotLease {
	private static Lease active;

	private SnapshotLease() {
	}

	public static Map<String, Object> begin(Executor server, Callable<Map<String, Object>> save, BooleanSupplier allowed) throws Exception {
		Lease lease;
		synchronized (SnapshotLease.class) {
			if (active != null) throw new IllegalStateException("another snapshot is already running");
			lease = new Lease(allowed);
			active = lease;
		}
		try {
			server.execute(() -> {
				try {
					if (lease.release.getCount() == 0 || !allowed.getAsBoolean()) throw new IllegalStateException("snapshot cancelled before save");
					Map<String, Object> result = new LinkedHashMap<>(save.call());
					lease.deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120);
					result.put("lease", lease.id);
					result.put("ok", true);
					lease.ready.complete(result);
					while (lease.valid() && !lease.release.await(100, TimeUnit.MILLISECONDS)) {
					}
				} catch (Throwable error) {
					lease.ready.completeExceptionally(error);
				} finally {
					synchronized (SnapshotLease.class) {
						if (active == lease) active = null;
					}
					lease.finished.complete(true);
				}
			});
			return lease.ready.get(90, TimeUnit.SECONDS);
		} catch (Exception error) {
			lease.release.countDown();
			synchronized (SnapshotLease.class) {
				if (active == lease && !lease.ready.isDone()) active = null;
			}
			throw error;
		}
	}

	public static Map<String, Object> finish(String id) throws Exception {
		Lease lease;
		boolean valid;
		synchronized (SnapshotLease.class) {
			lease = active;
			if (lease == null || !lease.id.equals(id)) return Json.map("ok", false, "error", "snapshot lease expired or does not match");
			valid = lease.valid();
			lease.release.countDown();
		}
		lease.finished.get(10, TimeUnit.SECONDS);
		return Json.map("ok", valid, "error", valid ? null : "snapshot lease expired or user took control");
	}

	private static final class Lease {
		final String id = UUID.randomUUID().toString();
		final BooleanSupplier allowed;
		final CountDownLatch release = new CountDownLatch(1);
		final CompletableFuture<Map<String, Object>> ready = new CompletableFuture<>();
		final CompletableFuture<Boolean> finished = new CompletableFuture<>();
		volatile long deadline;

		Lease(BooleanSupplier allowed) {
			this.allowed = allowed;
		}

		boolean valid() {
			return deadline > System.nanoTime() && allowed.getAsBoolean();
		}
	}
}
