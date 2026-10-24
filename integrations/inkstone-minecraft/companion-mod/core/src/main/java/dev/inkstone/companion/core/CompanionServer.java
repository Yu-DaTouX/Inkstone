package dev.inkstone.companion.core;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class CompanionServer {
	private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().serializeNulls().create();
	private static final int MAX_BODY = 1 << 20;

	private final byte[] token;
	private final HttpServer server;
	private final ExecutorService executor;
	private final Router router;

	public CompanionServer(int port, String token, Router router) throws IOException {
		this.token = token.getBytes(StandardCharsets.UTF_8);
		this.router = router;
		this.server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 16);
		this.executor = Executors.newFixedThreadPool(2, runnable -> {
			Thread thread = new Thread(runnable, "inkstone-companion-http");
			thread.setDaemon(true);
			return thread;
		});
		server.setExecutor(executor);
		server.createContext("/", this::handle);
	}

	public void start() {
		server.start();
	}

	public int port() {
		return server.getAddress().getPort();
	}

	private void stop() {
		server.stop(0);
		executor.shutdownNow();
	}

	private boolean authorized(HttpExchange exchange) {
		String header = exchange.getRequestHeaders().getFirst("Authorization");
		if (header == null || !header.startsWith("Bearer ")) return false;
		return MessageDigest.isEqual(token, header.substring(7).trim().getBytes(StandardCharsets.UTF_8));
	}

	private boolean hostAllowed(HttpExchange exchange) {
		String host = exchange.getRequestHeaders().getFirst("Host");
		if (host == null) return false;
		String name = host.contains(":") ? host.substring(0, host.lastIndexOf(':')) : host;
		return name.equals("127.0.0.1") || name.equals("localhost") || name.equals("[::1]");
	}

	private void handle(HttpExchange exchange) throws IOException {
		try {
			if (!hostAllowed(exchange)) {
				sendJson(exchange, 403, Map.of("ok", false, "error", "host not allowed"));
				return;
			}
			if (!authorized(exchange)) {
				sendJson(exchange, 401, Map.of("ok", false, "error", "bad token"));
				return;
			}
			JsonObject body = readBody(exchange);
			String path = exchange.getRequestURI().getPath();
			Response response = router.dispatch(path, body);
			if (response.png() != null) sendBytes(exchange, 200, "image/png", response.png());
			else sendJson(exchange, response.status(), response.json());
		} catch (LinkageError error) {
			sendJson(exchange, 501, Map.of("ok", false, "error", "this Minecraft version is not supported by the companion: " + error));
		} catch (Throwable error) {
			Companion.log("request failed: " + error);
			sendJson(exchange, 500, Map.of("ok", false, "error", String.valueOf(error.getMessage() == null ? error : error.getMessage())));
		} finally {
			exchange.close();
		}
	}

	private static JsonObject readBody(HttpExchange exchange) throws IOException {
		try (InputStream input = exchange.getRequestBody()) {
			byte[] bytes = input.readNBytes(MAX_BODY);
			String text = new String(bytes, StandardCharsets.UTF_8).trim();
			if (text.isEmpty()) return new JsonObject();
			return JsonParser.parseString(text).getAsJsonObject();
		}
	}

	private static void sendJson(HttpExchange exchange, int status, Object value) throws IOException {
		sendBytes(exchange, status, "application/json; charset=utf-8", GSON.toJson(value).getBytes(StandardCharsets.UTF_8));
	}

	private static void sendBytes(HttpExchange exchange, int status, String type, byte[] bytes) throws IOException {
		exchange.getResponseHeaders().set("Content-Type", type);
		exchange.sendResponseHeaders(status, bytes.length);
		try (OutputStream output = exchange.getResponseBody()) {
			output.write(bytes);
		}
	}

	public record Response(int status, Object json, byte[] png) {
		public static Response ok(Object json) {
			return new Response(200, json, null);
		}

		public static Response image(byte[] png) {
			return new Response(200, null, png);
		}

		public static Response error(int status, String message) {
			return new Response(status, Map.of("ok", false, "error", message), null);
		}
	}
}
