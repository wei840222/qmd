# Kubernetes 叢集升級

Kubernetes 叢集升級先檢查 API deprecation，再依序更新 control plane 與 worker node。升級期間要維持 PodDisruptionBudget 並驗證工作負載健康。
