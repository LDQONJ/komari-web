import NodeSelectorDialog from "@/components/NodeSelectorDialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import { useNodeDetails } from "@/contexts/NodeDetailsContext";
import { usePingTask, type PingTask } from "@/contexts/PingTaskContext";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Flex,
  IconButton,
  Select,
  TextField,
} from "@radix-ui/themes";
import { MenuIcon, MoreHorizontal, Pencil, Trash } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

const getTaskSortableId = (task: { id?: number; name?: string; target?: string }) =>
  task.id !== undefined
    ? `id-${task.id}`
    : `tmp-${task.name ?? ""}-${task.target ?? ""}`;

export const TaskView = ({ pingTasks }: { pingTasks: PingTask[] }) => {
  const { t } = useTranslation();
  const { refresh } = usePingTask();
  const { nodeDetail } = useNodeDetails();
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 10,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {})
  );

  // 过滤已删除的节点
  const processedTasks = React.useMemo(() => {
    if (!pingTasks)
      return [] as (PingTask & {
        __allClientsDeleted?: boolean;
        __originalCount?: number;
      })[];
    const nodeUuidSet = new Set(nodeDetail.map((n) => n.uuid));
    return pingTasks.map((task) => {
      const original = task.clients || [];
      const existing = original.filter((uuid) => nodeUuidSet.has(uuid));
      const allDeleted = original.length > 0 && existing.length === 0;
      return {
        ...task,
        clients: existing,
        __allClientsDeleted: allDeleted,
        __originalCount: original.length,
      };
    });
  }, [pingTasks, nodeDetail]);

  const [localTasks, setLocalTasks] = React.useState(processedTasks);

  React.useEffect(() => {
    setLocalTasks(processedTasks);
  }, [processedTasks]);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = localTasks.findIndex(
      (task) => getTaskSortableId(task) === String(active.id)
    );
    const newIndex = localTasks.findIndex(
      (task) => getTaskSortableId(task) === String(over.id)
    );
    if (oldIndex < 0 || newIndex < 0) return;

    const previousTasks = Array.from(localTasks);
    const reorderedTasks = Array.from(localTasks);
    const [reorderedItem] = reorderedTasks.splice(oldIndex, 1);
    reorderedTasks.splice(newIndex, 0, reorderedItem);

    setLocalTasks(reorderedTasks);

    const orderData = reorderedTasks.reduce((acc, task, index) => {
      if (task.id !== undefined) {
        acc[String(task.id)] = index;
      }
      return acc;
    }, {} as Record<string, number>);

    try {
      const response = await fetch("/api/admin/ping/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orderData),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.message || t("common.error"));
      }
    } catch (error: any) {
      setLocalTasks(previousTasks);
      toast.error(error?.message || t("common.error"));
      refresh();
    }
  };

  return (
    <div className="km-page-admin-pingtask-task km-pingtask-task-table rounded-xl overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10" aria-label={t("common.sort")}></TableHead>
            <TableHead>{t("common.name")}</TableHead>
            <TableHead>{t("common.server")}</TableHead>
            <TableHead>{t("ping.target")}</TableHead>
            <TableHead>{t("common.type")}</TableHead>
            <TableHead>{t("ping.interval")}</TableHead>
            <TableHead>{t("common.action")}</TableHead>
          </TableRow>
        </TableHeader>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={localTasks.map((task) => getTaskSortableId(task))}
            strategy={verticalListSortingStrategy}
          >
            <TableBody>
              {localTasks.map((task) => (
                <Row key={getTaskSortableId(task)} task={task} />
              ))}
            </TableBody>
          </SortableContext>
        </DndContext>
      </Table>
    </div>
  );
};

const Row = ({
  task,
}: {
  task: PingTask & { __allClientsDeleted?: boolean; __originalCount?: number };
}) => {
  const { t } = useTranslation();
  const { refresh } = usePingTask();
  const { nodeDetail } = useNodeDetails();
  const isMobile = useIsMobile();
  const sortableId = getTaskSortableId(task);
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: sortableId });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const [editOpen, setEditOpen] = React.useState(false);
  const [editSaving, setEditSaving] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteLoading, setDeleteLoading] = React.useState(false);
  const [form, setForm] = React.useState({
    name: task.name || "",
    type: task.type || "icmp",
    target: task.target || "",
    clients: task.clients || [],
    default_on: task.default_on || false,
    interval: task.interval || 60,
    is_reverse: task.is_reverse || false,
    reverse_source: task.reverse_source || "",
    port: task.port || 22,
    ip_preference: (task.ip_preference as "ipv4" | "ipv6") || "ipv4",
  });

  const sortedNodes = React.useMemo(() => {
    return [...nodeDetail].sort((a, b) => {
      const wa = a.weight ?? 0;
      const wb = b.weight ?? 0;
      if (wa !== wb) return wa - wb;
      return a.name.localeCompare(b.name);
    });
  }, [nodeDetail]);

  React.useEffect(() => {
    setForm({
      name: task.name || "",
      type: task.type || "icmp",
      target: task.target || "",
      clients: task.clients || [],
      default_on: task.default_on || false,
      interval: task.interval || 60,
      is_reverse: task.is_reverse || false,
      reverse_source: task.reverse_source || "",
      port: task.port || 22,
      ip_preference: (task.ip_preference as "ipv4" | "ipv6") || "ipv4",
    });
  }, [task, editOpen]);

  const submitEdit = (newForm: typeof form) => {
    if (!newForm.default_on && newForm.clients.length === 0) {
      toast.error(t("ping.default_on_description"));
      return;
    }
    setEditSaving(true);
    const isRev = Boolean(task.is_reverse || newForm.is_reverse);
    const targetVal = isRev
      ? (newForm.type === "tcp" ? `:${newForm.port || 22}` : "icmp")
      : newForm.target;

    fetch("/api/admin/ping/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tasks: [
          {
            id: task.id,
            name: newForm.name,
            type: newForm.type,
            target: targetVal,
            default_on: newForm.default_on,
            clients: newForm.clients,
            interval: newForm.interval,
            is_reverse: isRev,
            reverse_source: newForm.reverse_source || task.reverse_source,
            port: newForm.port || task.port || 22,
            ip_preference: newForm.ip_preference || task.ip_preference || "ipv4",
          },
        ],
      }),
    })
      .then((res) => {
        if (!res.ok) {
          return res.json().then((data) => {
            throw new Error(data?.message || t("common.error"));
          });
        }
        return res.json();
      })
      .then(() => {
        setEditOpen(false);
        toast.success(t("common.updated_successfully"));
        refresh();
      })
      .catch((error) => {
        toast.error(error.message);
      })
      .finally(() => setEditSaving(false));
  };

  // 编辑提交
  const handleEdit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submitEdit(form);
  };

  // 删除
  const handleDelete = () => {
    setDeleteLoading(true);
    fetch("/api/admin/ping/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: [task.id] }),
    })
      .then((res) => {
        if (!res.ok) {
          return res.json().then((data) => {
            throw new Error(data?.message || t("common.error"));
          });
        }
        return res.json();
      })
      .then(() => {
        setDeleteOpen(false);
        toast.success(t("common.deleted_successfully"));
        refresh();
      })
      .catch((error) => {
        toast.error(error.message);
      })
      .finally(() => setDeleteLoading(false));
  };

  return (
    <TableRow ref={setNodeRef} style={style}>
      <TableCell>
        <div
          {...attributes}
          {...listeners}
          className={`cursor-move p-2 rounded hover:bg-accent-a3 transition-colors ${
            isMobile ? "touch-manipulation select-none" : ""
          }`}
          style={{
            touchAction: "none",
            WebkitUserSelect: "none",
            userSelect: "none",
          }}
          title={
            isMobile
              ? t("admin.nodeTable.dragToReorder", "长按拖拽重新排序")
              : undefined
          }
        >
          <MenuIcon size={isMobile ? 18 : 16} color={"var(--gray-8)"} />
        </div>
      </TableCell>
      <TableCell>
        <Flex gap="1" align="center">
          <span>{task.name}</span>
          {task.is_reverse && (
            <Badge size="1" color="indigo" variant="soft">
              {t("ping.reverse_badge", "反向")}
            </Badge>
          )}
        </Flex>
      </TableCell>
      <TableCell>
        <Flex gap="2" align="center">
          {task.clients && task.clients.length > 0
            ? (() => {
                const names = task.clients.map((uuid) => {
                  const name =
                    nodeDetail.find((node) => node.uuid === uuid)?.name || uuid;
                  return name;
                });
                const joined = names.join(", ");
                return joined.length > 40
                  ? joined.slice(0, 40) + "..."
                  : joined;
              })()
            : t("common.none")}
          {task.default_on && (
            <span className="text-xs text-accent-11">
              {t("ping.default_on_short")}
            </span>
          )}
          <NodeSelectorDialog
            value={form.clients ?? []}
            onChange={(uuids) => {
              const nextForm = { ...form, clients: uuids };
              setForm(nextForm);
              submitEdit(nextForm);
            }}
          >
            <IconButton
              variant="ghost"
              title={t("common.select_clients", "Select clients")}
              aria-label={t("common.select_clients", "Select clients")}
            >
              <MoreHorizontal size="16" />
            </IconButton>
          </NodeSelectorDialog>
        </Flex>
      </TableCell>
      <TableCell>
        {task.is_reverse ? (
          <span className="text-xs text-indigo-11">
            {t("ping.reverse_from", {
              source:
                nodeDetail.find((node) => node.uuid === task.reverse_source)
                  ?.name || task.reverse_source || "Probe",
            })}
            {task.type === "tcp" && task.port ? ` :${task.port}` : ""}
          </span>
        ) : (
          task.target
        )}
      </TableCell>
      <TableCell>{task.type}</TableCell>
      <TableCell>{task.interval}</TableCell>
      <TableCell className="flex items-center gap-2">
        {/* 编辑按钮 */}
        <Dialog.Root open={editOpen} onOpenChange={setEditOpen}>
          <Dialog.Trigger>
            <IconButton
              variant="soft"
              title={t("common.edit", "Edit")}
              aria-label={t("common.edit", "Edit")}
            >
              <Pencil size="16" />
            </IconButton>
          </Dialog.Trigger>
          <Dialog.Content className="km-pingtask-task-form">
            <Dialog.Title>{t("common.edit")}</Dialog.Title>
            <form onSubmit={handleEdit} className="flex flex-col gap-2">
              <label>{t("common.name")}</label>
              <TextField.Root
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                required
              />
              <label>{t("common.type")}</label>
              <Select.Root
                value={form.type}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, type: v as any }))
                }
              >
                <Select.Trigger />
                <Select.Content>
                  <Select.Item value="icmp">ICMP</Select.Item>
                  <Select.Item value="tcp">TCP</Select.Item>
                  {!task.is_reverse && <Select.Item value="http">HTTP</Select.Item>}
                </Select.Content>
              </Select.Root>

              {task.is_reverse ? (
                <>
                  <label>{t("ping.reverse_source", "探针服务器 (发起探测)")}</label>
                  <Select.Root
                    value={form.reverse_source}
                    onValueChange={(v) =>
                      setForm((f) => ({ ...f, reverse_source: v }))
                    }
                  >
                    <Select.Trigger />
                    <Select.Content>
                      {sortedNodes.map((n) => (
                        <Select.Item key={n.uuid} value={n.uuid}>
                          {n.name}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>

                  {form.type === "tcp" && (
                    <>
                      <label>{t("ping.target_port", "目标端口")}</label>
                      <TextField.Root
                        type="number"
                        value={form.port}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            port: Number(e.target.value),
                          }))
                        }
                        required
                      />
                    </>
                  )}

                  <label>{t("ping.ip_preference", "IP 解析偏好")}</label>
                  <Select.Root
                    value={form.ip_preference}
                    onValueChange={(v) =>
                      setForm((f) => ({ ...f, ip_preference: v as any }))
                    }
                  >
                    <Select.Trigger />
                    <Select.Content>
                      <Select.Item value="ipv4">IPv4 优先</Select.Item>
                      <Select.Item value="ipv6">IPv6 优先</Select.Item>
                    </Select.Content>
                  </Select.Root>
                </>
              ) : (
                <>
                  <label>{t("ping.target")}</label>
                  <TextField.Root
                    value={form.target}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, target: e.target.value }))
                    }
                    required
                  />
                </>
              )}

              <label>
                {task.is_reverse
                  ? t("ping.reverse_targets", "受测目标服务器")
                  : t("common.server")}
              </label>
              <Flex direction="column" gap="2">
                <NodeSelectorDialog
                  value={form.clients}
                  onChange={(v) => setForm((f) => ({ ...f, clients: v }))}
                />
                <label className="text-sm font-normal text-gray-500">
                  {t("common.selected", { count: form.clients.length })}
                </label>
                <label className="flex min-h-10 items-center gap-2 text-sm font-normal">
                  <Checkbox
                    checked={form.default_on}
                    onCheckedChange={(checked) =>
                      setForm((f) => ({ ...f, default_on: !!checked }))
                    }
                  />
                  <span>{t("ping.default_on")}</span>
                </label>
                <label className="text-sm font-normal text-gray-500">
                  {t("ping.default_on_description")}
                </label>
              </Flex>
              <label>
                {t("ping.interval")} ({t("time.second")})
              </label>
              <TextField.Root
                type="number"
                value={form.interval}
                onChange={(e) =>
                  setForm((f) => ({ ...f, interval: Number(e.target.value) }))
                }
                required
              />
              <Flex gap="2" justify="end" className="mt-4">
                <Dialog.Close>
                  <Button
                    variant="soft"
                    color="gray"
                    type="button"
                    onClick={() => setEditOpen(false)}
                  >
                    {t("common.cancel")}
                  </Button>
                </Dialog.Close>
                <Button variant="solid" type="submit" disabled={editSaving}>
                  {t("common.save")}
                </Button>
              </Flex>
            </form>
          </Dialog.Content>
        </Dialog.Root>
        {/* 删除按钮 */}
        <Dialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
          <Dialog.Trigger>
            <IconButton
              variant="soft"
              color="red"
              title={t("common.delete", "Delete")}
              aria-label={t("common.delete", "Delete")}
            >
              <Trash size="16" />
            </IconButton>
          </Dialog.Trigger>
          <Dialog.Content>
            <Dialog.Title>{t("common.delete")}</Dialog.Title>
            <Flex gap="2" justify="end" className="mt-4">
              <Dialog.Close>
                <Button
                  variant="soft"
                  color="gray"
                  type="button"
                  onClick={() => setDeleteOpen(false)}
                >
                  {t("common.cancel")}
                </Button>
              </Dialog.Close>
              <Button
                variant="solid"
                color="red"
                onClick={handleDelete}
                disabled={deleteLoading}
              >
                {t("common.delete")}
              </Button>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
      </TableCell>
    </TableRow>
  );
};
