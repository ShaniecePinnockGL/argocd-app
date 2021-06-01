package main

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/jessevdk/go-flags"
	"golang.org/x/sync/errgroup"
)

type Options struct {
	Context        string   `short:"c" long:"context" description:"K8s context used to run script" required:"true"`
	Namespace      string   `short:"n" long:"namespace" description:"K8s namespace to commands in" required:"true"`
	Application    []string `short:"a" long:"application" description:"Application to migrate" required:"true"`
	Region         string   `short:"r" long:"region" description:"Region" required:"true"`
	RancherToken   string   `long:"rancher-token" description:"Rancher token" required:"true"`
	RancherContext string   `long:"rancher-context" description:"Rancher context" required:"true"`
	Force          bool     `short:"f" long:"force" description:"Ignores Argo CD Sync check"`
}

func (o Options) switchContext() error {
	_, err := exec.Command("kubectl", "config", "use-context", o.Context).Output()
	if err != nil {
		return fmt.Errorf("[%s] cannot switch contexts: %s", o.Context, err.Error())
	}
	fmt.Printf("[%s] switched context\n", o.Context)
	return nil
}

func (o Options) validateNamespace() error {
	_, err := exec.Command("kubectl", "get", "namespace", o.Namespace).Output()
	if err != nil {
		return fmt.Errorf("[%s] cannot access namespace: %s", o.Namespace, err.Error())
	}
	fmt.Printf("[%s] namespace exists\n", o.Namespace)
	return nil
}

func validateArgoCdAuth() error {
	_, err := exec.Command("argocd", "app", "list").Output()
	if err != nil {
		fmt.Println("trying to log into argo cd")
		_, err = exec.Command("argocd", "login", "argocd.external.glops.io", "--sso", "--grpc-web-root-path", "/").Output()
		time.Sleep(3 * time.Second)
		if err != nil {
			return fmt.Errorf("cannot log into argo cd; please login using `argocd login argocd.external.glops.io --sso --grpc-web-root-path /`")
		}
	}
	fmt.Println("argo cd authenticated")
	return nil
}

func (o Options) validateRancherAuth() error {
	_, err := exec.Command("rancher", "login", "-t", o.RancherToken, "--context", o.RancherContext, "https://ops-rancher.greenlight.me/v3").Output()
	if err != nil {
		return fmt.Errorf("cannot authenticate with rancher: %s", err.Error())
	}
	fmt.Printf("[%s] authenticated with rancher\n", o.RancherContext)
	return nil
}

func (o Options) validatePermissions() error {
	_, err := exec.Command("kubectl", "auth", "can-i", "delete", "configmaps", "--namespace", o.Namespace).Output()
	if err != nil {
		return fmt.Errorf("[%s] not authorized to delete configmaps: %s", o.Namespace, err.Error())
	}
	fmt.Printf("[%s] validated namespace permissions\n", o.Namespace)
	return nil
}

// Example of healthy app:
// krona-reconciliation-qainternal-e1 qainternal krona-qainternal Synced Healthy Auto-Prune <none> https://greenlight.jfrog.io/artifactory/gl-helm 2.4.0-rc.1
func (o Options) validateArgoCdApp(app string, force bool) error {
	if !force {
		stdOut, err := exec.Command("argocd", "app", "list", "-l", fmt.Sprintf("namespace=%s,application=%s,region=%s", o.Namespace, app, o.Region)).Output()
		if err != nil {
			return fmt.Errorf("[%s-%s-%s] cannot list argo cd applications: %s", app, o.Namespace, o.Region, err.Error())
		}
		if !regexp.MustCompile(fmt.Sprintf(`.*-%s-%s-%s.*Synced.*Healthy`, app, o.Namespace, o.Region)).MatchString(string(stdOut)) {
			return fmt.Errorf("[%s-%s-%s] not synced in argo cd", app, o.Namespace, o.Region)
		}
		fmt.Printf("[%s-%s-%s] synced in argo cd\n", app, o.Namespace, o.Region)
	}
	return nil
}

func (o Options) validateRancherApp(app string) error {
	stdOut, err := exec.Command("rancher", "apps", "ls").Output()
	if !regexp.MustCompile(fmt.Sprintf(`%s(-%s)?[a-zA-Z0-9 ].*(active|installing)`, app, o.Namespace)).MatchString(string(stdOut)) {
		return fmt.Errorf("[%s-%s-%s] cannot find rancher application", app, o.Namespace, o.Region)
	}
	if err != nil {
		return fmt.Errorf("[%s-%s-%s] cannot list rancher applications: %s", app, o.Namespace, o.Region, err.Error())
	}
	fmt.Printf("[%s-%s-%s] found rancher application\n", app, o.Namespace, o.Region)
	return nil
}

func (o Options) deleteConfigMaps(app string) error {
	stdOut, err := exec.Command("kubectl", "delete", "configmaps", "-n", o.Namespace, "-l", fmt.Sprintf("NAME=%s-%s", app, o.Namespace)).Output()
	if err != nil || string(stdOut) == "No resources found\n" {
		fmt.Printf("[%s-%s-%s] cannot delete configmaps; trying without namespace\n", app, o.Namespace, o.Region)
		stdOut, err = exec.Command("kubectl", "delete", "configmaps", "-n", o.Namespace, "-l", fmt.Sprintf("NAME=%s", app)).Output()
		if err != nil || string(stdOut) == "No resources found\n" {
			return fmt.Errorf("[%s-%s-%s] cannot delete configmaps; giving up", app, o.Namespace, o.Region)
		}
	}
	fmt.Printf("[%s-%s-%s] successfully delete configmaps\n", app, o.Namespace, o.Region)
	time.Sleep(2 * time.Second)
	return nil
}

func (o Options) deleteRancherApp(app string) error {
	_, err := exec.Command("rancher", "app", "delete", fmt.Sprintf("%s-%s", app, o.Namespace)).Output()
	if err != nil {
		fmt.Printf("[%s-%s-%s] cannot delete rancher application; trying without namespace\n", app, o.Namespace, o.Region)
		_, err = exec.Command("rancher", "app", "delete", app).Output()
		if err != nil {
			return fmt.Errorf("[%s-%s-%s] cannot delete rancher application; giving up: %s", app, o.Namespace, o.Region, err.Error())
		}
	}
	fmt.Printf("[%s-%s-%s] successfully deleted rancher application\n", app, o.Namespace, o.Region)
	time.Sleep(5 * time.Second)
	return nil
}

func main() {
	opts := new(Options)
	_, err := flags.ParseArgs(opts, os.Args)
	if err != nil {
		os.Exit(1)
	}
	if opts.Force {
		fmt.Print("using -force can be dangerous. press enter to continue or ctrl + c to quit.")
		var noop string
		_, _ = fmt.Scanln(&noop)
	}
	if opts.Region != "e1" && opts.Region != "e2" {
		fmt.Println("invalid region. must be one of [e1, e2].")
		os.Exit(1)
	}
	err = opts.switchContext()
	if err != nil {
		fmt.Println(err.Error())
		os.Exit(1)
	}
	err = opts.validateNamespace()
	if err != nil {
		fmt.Println(err.Error())
		os.Exit(1)
	}
	err = validateArgoCdAuth()
	if err != nil {
		fmt.Println(err.Error())
		os.Exit(1)
	}
	err = opts.validateRancherAuth()
	if err != nil {
		fmt.Println(err.Error())
		os.Exit(1)
	}
	err = opts.validatePermissions()
	if err != nil {
		fmt.Println(err.Error())
		os.Exit(1)
	}
	var eg errgroup.Group
	var errs []error
	for _, app := range opts.Application {
		app := app
		eg.Go(func() error {
			err = opts.validateArgoCdApp(app, opts.Force)
			if err != nil {
				errs = append(errs, err)
				return nil
			}
			err = opts.validateRancherApp(app)
			if err != nil {
				errs = append(errs, err)
				return nil
			}
			err = opts.deleteConfigMaps(app)
			if err != nil {
				errs = append(errs, err)
				return nil
			}
			err = opts.deleteRancherApp(app)
			if err != nil {
				errs = append(errs, err)
				return nil
			}
			err = opts.validateArgoCdApp(app, false)
			if err != nil {
				errs = append(errs, err)
				return nil
			}
			return nil
		})
	}
	err = eg.Wait()
	fmt.Println(strings.Repeat("=", 20))
	if len(errs) > 0 {
		fmt.Printf("found %d issues:\n", len(errs))
		for _, e := range errs {
			fmt.Println(e.Error())
		}
		os.Exit(1)
	}
	fmt.Println("no issues found; migration complete")
}
