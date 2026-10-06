import asyncio
import json
from src.config import logger

class EventBroadcaster:
    def __init__(self):
        self._subscribers = set()
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue:
        queue = asyncio.Queue(maxsize=200)
        async with self._lock:
            self._subscribers.add(queue)
        logger.debug(f"New SSE client subscribed. Total active listeners: {len(self._subscribers)}")
        return queue

    async def unsubscribe(self, queue: asyncio.Queue) -> None:
        async with self._lock:
            self._subscribers.discard(queue)
        logger.debug(f"SSE client unsubscribed. Remaining active listeners: {len(self._subscribers)}")

    async def broadcast(self, event_type: str, data: dict = None) -> None:
        if data is None:
            data = {}
        payload = json.dumps({"type": event_type, "data": data})
        async with self._lock:
            dead_queues = []
            for queue in self._subscribers:
                try:
                    queue.put_nowait(payload)
                except asyncio.QueueFull:
                    try:
                        queue.get_nowait()
                        queue.put_nowait(payload)
                    except Exception:
                        dead_queues.append(queue)
                except Exception:
                    dead_queues.append(queue)
            for dead in dead_queues:
                self._subscribers.discard(dead)

event_broadcaster = EventBroadcaster()

def broadcast_event(event_type: str, data: dict = None) -> None:
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(event_broadcaster.broadcast(event_type, data))
    except RuntimeError:
        pass
