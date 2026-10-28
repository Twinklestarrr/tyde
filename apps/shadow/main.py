"""启动本地 Agent API 服务。"""

import uvicorn
import argparse

from config.runtime import prepare_runtime


def main() -> None:
    parser = argparse.ArgumentParser(description="Shadow 本地 Agent 服务")
    parser.add_argument("--check-runtime", action="store_true", help="检查依赖，不启动服务或操作桌面")
    args = parser.parse_args()
    prepare_runtime()
    if args.check_runtime:
        from deploy.runtime_check import check_runtime

        check_runtime()
        print("运行依赖检查通过（模块加载与初始化正常）")
        return
    # 配置初始化完成后再读取 Settings，避免将用户数据写入包内资源目录。
    from api.server import app
    from config.settings import settings

    uvicorn.run(app, host=settings.API_HOST, port=settings.API_PORT)


if __name__ == "__main__":
    main()
