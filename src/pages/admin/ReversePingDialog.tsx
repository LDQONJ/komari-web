import React from "react";
import {
  Button,
  Dialog,
  Flex,
  Select,
  TextField,
} from "@radix-ui/themes";
import { ArrowLeftRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import NodeSelectorDialog from "@/components/NodeSelectorDialog";
import { useNodeDetails } from "@/contexts/NodeDetailsContext";
import { usePingTask } from "@/contexts/PingTaskContext";

export const ReversePingDialog: React.FC = () => {
  const { t } = useTranslation();
  const { nodeDetail } = useNodeDetails();
  const { refresh } = usePingTask();
  const [isOpen, setIsOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // 表单状态
  const [name, setName] = React.useState("");
  const [sourceUuid, setSourceUuid] = React.useState("");
  const [targetUuids, setTargetUuids] = React.useState<string[]>([]);
  const [pingType, setPingType] = React.useState<"tcp" | "icmp">("tcp");
  const [port, setPort] = React.useState(22);
  const [interval, setInterval] = React.useState(60);
  const [ipPreference, setIpPreference] = React.useState<"ipv4" | "ipv6">("ipv4");

  // 排序节点列表
  const sortedNodes = React.useMemo(() => {
    return [...nodeDetail].sort((a, b) => {
      const wa = a.weight ?? 0;
      const wb = b.weight ?? 0;
      if (wa !== wb) return wa - wb;
      return a.name.localeCompare(b.name);
    });
  }, [nodeDetail]);

  // 默认选择第一个可用的源节点
  React.useEffect(() => {
    if (!sourceUuid && sortedNodes.length > 0) {
      // 优先看是否有包含 "Home" 的节点，否则选第一个
      const homeNode = sortedNodes.find((n) =>
        n.name.toLowerCase().includes("home")
      );
      setSourceUuid(homeNode ? homeNode.uuid : sortedNodes[0].uuid);
    }
  }, [sortedNodes, sourceUuid]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!name.trim()) {
      toast.error(t("common.name_required", "Name is required"));
      return;
    }
    if (!sourceUuid) {
      toast.error(t("ping.reverse_source_required", "Please select a probe source server"));
      return;
    }

    // 过滤掉源节点自身
    const finalTargets = targetUuids.filter((uuid) => uuid !== sourceUuid);
    if (finalTargets.length === 0) {
      toast.error(t("ping.reverse_targets_required", "Please select at least one target server"));
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/admin/ping/addReverse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          reverse_source: sourceUuid,
          targets: finalTargets,
          type: pingType,
          port: pingType === "tcp" ? port : 0,
          interval: interval > 0 ? interval : 60,
          ip_preference: ipPreference,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.message || t("common.error"));
      }

      toast.success(t("common.saved_successfully", "Tasks created successfully"));
      setIsOpen(false);
      setName("");
      setTargetUuids([]);
      refresh();
    } catch (err: any) {
      toast.error(err.message || t("common.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={setIsOpen}>
      <Dialog.Trigger>
        <Button variant="soft" color="indigo" className="cursor-pointer">
          <ArrowLeftRight size={16} />
          {t("ping.add_reverse", "反向监测")}
        </Button>
      </Dialog.Trigger>

      <Dialog.Content className="km-pingtask-reverse-form max-w-lg">
        <Dialog.Title className="flex items-center gap-2">
          <ArrowLeftRight size={20} className="text-indigo-500" />
          {t("ping.add_reverse_title", "添加反向延迟监测")}
        </Dialog.Title>
        <Dialog.Description size="2" mb="4" color="gray">
          {t(
            "ping.reverse_description",
            "由指定的探针服务器（如家宽节点）反向探测所选的其它节点，并将探测结果直接记录在受测目标节点名下。"
          )}
        </Dialog.Description>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {/* 任务名称 */}
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">{t("common.name", "任务名称")}</label>
            <TextField.Root
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("ping.reverse_name_placeholder", "例如：家宽延迟 或 Home 延迟")}
              required
            />
          </div>

          {/* 探针源服务器 */}
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">
              {t("ping.reverse_source", "探针服务器 (发起探测)")}
            </label>
            <Select.Root value={sourceUuid} onValueChange={setSourceUuid}>
              <Select.Trigger className="w-full" />
              <Select.Content position="popper">
                {sortedNodes.map((n) => (
                  <Select.Item key={n.uuid} value={n.uuid}>
                    {n.name} ({n.ipv4 || n.ipv6 || "No IP"})
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </div>

          {/* 受测目标服务器 */}
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">
              {t("ping.reverse_targets", "受测服务器 (数据归属)")}
            </label>
            <Flex direction="column" gap="1">
              <NodeSelectorDialog
                value={targetUuids}
                onChange={setTargetUuids}
              />
              <span className="text-xs text-gray-500">
                {t("common.selected", { count: targetUuids.length })}
              </span>
            </Flex>
          </div>

          {/* 协议方式与端口 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">{t("common.type", "协议")}</label>
              <Select.Root
                value={pingType}
                onValueChange={(v) => setPingType(v as "tcp" | "icmp")}
              >
                <Select.Trigger />
                <Select.Content position="popper">
                  <Select.Item value="tcp">TCP (TCPing)</Select.Item>
                  <Select.Item value="icmp">ICMP (Ping)</Select.Item>
                </Select.Content>
              </Select.Root>
            </div>

            {pingType === "tcp" ? (
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">{t("ping.target_port", "目标端口")}</label>
                <TextField.Root
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  placeholder="22"
                  min={1}
                  max={65535}
                  required
                />
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">{t("ping.ip_preference", "IP 解析偏好")}</label>
                <Select.Root
                  value={ipPreference}
                  onValueChange={(v) => setIpPreference(v as "ipv4" | "ipv6")}
                >
                  <Select.Trigger />
                  <Select.Content position="popper">
                    <Select.Item value="ipv4">IPv4 优先</Select.Item>
                    <Select.Item value="ipv6">IPv6 优先</Select.Item>
                  </Select.Content>
                </Select.Root>
              </div>
            )}
          </div>

          {/* 探测间隔 */}
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">
              {t("ping.interval", "探测间隔")} ({t("time.second", "秒")})
            </label>
            <TextField.Root
              type="number"
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
              min={5}
              required
            />
          </div>

          {/* 底部按钮 */}
          <Flex gap="3" justify="end" mt="4">
            <Dialog.Close>
              <Button
                variant="soft"
                color="gray"
                type="button"
                onClick={() => setIsOpen(false)}
              >
                {t("common.cancel", "取消")}
              </Button>
            </Dialog.Close>
            <Button variant="solid" color="indigo" type="submit" disabled={saving}>
              {t("common.save", "创建反向监测")}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
};
