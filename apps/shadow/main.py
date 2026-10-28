"""启动本地 Agent API 服务。"""

import uvicorn

from api.server import app
from config.settings import settings


def main() -> None:
    uvicorn.run(app, host=settings.API_HOST, port=settings.API_PORT)


if __name__ == "__main__":
    main()
