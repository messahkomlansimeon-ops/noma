#!/usr/bin/env python3
"""Parseur CoinAfrique Scrapling hors réseau, piloté uniquement par stdin/stdout."""

from __future__ import annotations

import math
import os
import re
import socket
import sys
import time
from typing import Any
from urllib.parse import urlparse

import orjson
from scrapling import Selector

MAX_BYTES = 2_000_000
CARD_SELECTOR = "div.card.ad__card"
ADAPTIVE_IDENTIFIER = "noma-coinafrique-card-v1"
NETWORK_ATTEMPTS = 0


def _network_forbidden(*_args: Any, **_kwargs: Any) -> None:
    global NETWORK_ATTEMPTS
    NETWORK_ATTEMPTS += 1
    raise RuntimeError("network access is forbidden in the Scrapling parser pilot")


class _OfflineSocket(socket.socket):
    def connect(self, *_args: Any, **_kwargs: Any) -> None:
        _network_forbidden()

    def connect_ex(self, *_args: Any, **_kwargs: Any) -> int:
        _network_forbidden()
        return 1


socket.socket = _OfflineSocket  # type: ignore[assignment]
socket.create_connection = _network_forbidden  # type: ignore[assignment]
socket.getaddrinfo = _network_forbidden  # type: ignore[assignment]


def _rss_bytes() -> int:
    try:
        with open("/proc/self/statm", "r", encoding="ascii") as handle:
            resident_pages = int(handle.read().split()[1])
        return resident_pages * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        return 0


def _text(node: Selector | None) -> str | None:
    if node is None:
        return None
    value = str(node.get_all_text(separator="", valid_values=False)).strip()
    return value or None


def _first(nodes: Any) -> Selector | None:
    return nodes[0] if nodes else None


def _parse_float_like_js(value: str | None) -> float | None:
    if not value:
        return None
    match = re.match(r"\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)", value)
    if not match:
        return None
    parsed = float(match.group(0))
    return parsed if math.isfinite(parsed) else None


def _parse_card(card: Selector, index: int, base_url: str) -> dict[str, Any] | None:
    link = _first(card.css("a.ad__card-image"))
    favorite = _first(card.css(".card-fav"))
    if link is None:
        return None

    href = str(link.attrib.get("href", "")).strip() or None
    title = None
    if favorite is not None:
        title = str(favorite.attrib.get("data-ad-title", "")).strip() or None
    title = title or str(link.attrib.get("title", "")).strip() or None
    if not href or not title:
        return None

    id_match = re.search(r"(\d+)\s*$", href)
    if not id_match:
        return None

    price_raw = None if favorite is None else favorite.attrib.get("data-ad-price")
    category = None if favorite is None else favorite.attrib.get("data-ad-category")
    photo = _first(card.css("img.ad__card-img"))
    location = _text(_first(card.css("p.ad__card-location span")))
    times = " ".join(
        value for value in (_text(node) for node in card.css(".ad__card-timesince span")) if value
    ).strip()
    description = _text(_first(card.css("p.ad__card-description")))
    zone = None
    if location:
        zone = re.sub(r"Côte d'?Ivoire", "", location, flags=re.IGNORECASE).strip()
        zone = re.sub(r",$", "", zone) or None

    parsed_base = urlparse(base_url)
    origin = f"{parsed_base.scheme}://{parsed_base.netloc}"
    absolute_url = href if href.startswith("http") else f"{origin}{href}"
    category_text = str(category) if category is not None else None

    return {
        "id": f"coin-{id_match.group(1) or index}",
        "source": "coinafrique",
        "title": title,
        "price": _parse_float_like_js(str(price_raw) if price_raw is not None else None),
        "currency": "FCFA",
        "zone": zone,
        "vendor": None,
        "url": absolute_url,
        "photo": None if photo is None else (str(photo.attrib.get("src", "")).strip() or None),
        "date": f"il y a {times}" if times else None,
        "description": f"{category_text} — {description or title}" if category_text else description,
    }


def _validate_request(raw: bytes) -> dict[str, Any]:
    if len(raw) > MAX_BYTES:
        raise ValueError("input exceeds 2000000 bytes")
    data = orjson.loads(raw)
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError("unsupported request version")
    html = data.get("html")
    base_url = data.get("baseUrl")
    mode = data.get("mode")
    if not isinstance(html, str) or not isinstance(base_url, str):
        raise ValueError("html and baseUrl must be strings")
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("baseUrl must be an HTTP(S) URL")
    if mode not in {"standard", "adaptive-train", "adaptive"}:
        raise ValueError("invalid mode")
    if mode != "standard":
        storage_path = data.get("storagePath")
        if not isinstance(storage_path, str) or not os.path.isabs(storage_path):
            raise ValueError("adaptive mode requires an absolute storagePath")
    return data


def main() -> int:
    started = time.perf_counter()
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    request = _validate_request(raw)
    mode = request["mode"]
    adaptive = mode != "standard"
    selector_options: dict[str, Any] = {
        "content": request["html"],
        "url": request["baseUrl"],
        "adaptive": adaptive,
    }
    if adaptive:
        selector_options["storage_args"] = {
            "storage_file": request["storagePath"],
            "url": request["baseUrl"],
        }

    page = Selector(**selector_options)
    cards = page.css(
        CARD_SELECTOR,
        identifier=ADAPTIVE_IDENTIFIER,
        auto_save=mode == "adaptive-train",
        adaptive=mode == "adaptive",
    )
    listings: list[dict[str, Any]] = []
    bad_cards = 0
    for index, card in enumerate(cards):
        try:
            parsed = _parse_card(card, index, request["baseUrl"])
        except Exception:
            parsed = None
        if parsed is not None:
            listings.append(parsed)
        elif index < 5:
            bad_cards += 1

    response = {
        "version": 1,
        "listings": listings,
        "errors": [f"{bad_cards} cartes illisibles ignorées"] if bad_cards else [],
        "metrics": {
            "durationMs": (time.perf_counter() - started) * 1000,
            "rssBytes": _rss_bytes(),
            "networkAttempts": NETWORK_ATTEMPTS,
        },
    }
    encoded = orjson.dumps(response)
    if len(encoded) > MAX_BYTES:
        raise ValueError("output exceeds 2000000 bytes")
    sys.stdout.buffer.write(encoded)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        message = f"{type(error).__name__}: {error}".encode("utf-8", errors="replace")[:16_000]
        sys.stderr.buffer.write(message)
        raise SystemExit(1)
