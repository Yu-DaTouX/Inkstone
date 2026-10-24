package dev.inkstone.companion.core;

public final class Hover {
	private record Point(double x, double y, Object owner) {
	}

	private static volatile Point point;

	private Hover() {
	}

	public static void set(double x, double y, Object owner) {
		point = new Point(x, y, owner);
	}

	public static void clear() {
		point = null;
	}

	public static double[] point(Object currentOwner) {
		Point current = point;
		if (current == null) return null;
		if (current.owner() != currentOwner) {
			point = null;
			return null;
		}
		return new double[] {current.x(), current.y()};
	}
}
