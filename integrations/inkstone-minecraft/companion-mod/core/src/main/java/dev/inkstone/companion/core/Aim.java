package dev.inkstone.companion.core;

public final class Aim {
	private Aim() {
	}

	public static float[] angles(double[] eye, double[] target) {
		double dx = target[0] - eye[0];
		double dy = target[1] - eye[1];
		double dz = target[2] - eye[2];
		double horizontal = Math.sqrt(dx * dx + dz * dz);
		float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
		float pitch = (float) -Math.toDegrees(Math.atan2(dy, horizontal));
		return new float[] {yaw, pitch};
	}

	public static boolean project(double[] eye, float yaw, float pitch, double fov, double[] point, int width, int height, double[] out) {
		double yawRadians = Math.toRadians(yaw);
		double pitchRadians = Math.toRadians(pitch);
		double cosYaw = Math.cos(yawRadians);
		double sinYaw = Math.sin(yawRadians);
		double cosPitch = Math.cos(pitchRadians);
		double sinPitch = Math.sin(pitchRadians);
		double forwardX = -sinYaw * cosPitch;
		double forwardY = -sinPitch;
		double forwardZ = cosYaw * cosPitch;
		double rightX = cosYaw;
		double rightZ = sinYaw;
		double upX = -sinPitch * sinYaw;
		double upY = cosPitch;
		double upZ = sinPitch * cosYaw;
		double dx = point[0] - eye[0];
		double dy = point[1] - eye[1];
		double dz = point[2] - eye[2];
		double depth = dx * forwardX + dy * forwardY + dz * forwardZ;
		if (depth <= 0.05) return false;
		double side = dx * rightX + dz * rightZ;
		double up = dx * upX + dy * upY + dz * upZ;
		double focal = 1.0 / Math.tan(Math.toRadians(Math.max(1.0, Math.min(170.0, fov))) / 2.0);
		double halfHeight = height / 2.0;
		out[0] = width / 2.0 + side / depth * focal * halfHeight;
		out[1] = height / 2.0 - up / depth * focal * halfHeight;
		out[2] = depth;
		return true;
	}
}
